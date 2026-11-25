// The browser extension's hands in Chrome. It drives tabs here through Chrome's debugger,
// over the native messaging port (background.js). Each session is one tab: one
// an agent opened, in the background and in a collapsed group so the person's own tabs
// and focus are left alone, or one of theirs it took over. Sessions are kept in
// storage, so they outlive this worker. An idle tab lets go of the debugger
// after a minute (Chrome's "started debugging" bar goes with it) and closes
// after half an hour, unless it's held for an ask or in front of the person.
// A tab in the agents' group that no session holds any more (Chrome gave it
// a new id, its session lost track of it) closes after half an hour too.
// Ported from Switchboard's extension, itself grown from Agent Quick Browse's bridge (MIT).

const GROUP = "Switch"
const NO_GROUP = chrome.tabGroups.TAB_GROUP_ID_NONE
const DETACH_AFTER_MS = 60_000
const CLOSE_AFTER_MS = 30 * 60_000
/** How long without a key or click on this Mac before a tab in front of the person counts as left there, not theirs. */
const AWAY_S = 15 * 60

/** When each session was last used, in memory: a restarted worker counts from its start. */
const used = new Map()
const started = Date.now()
const attached = new Set()
/** Other sites' frames in each tab (a card form's secure boxes), as debugger sessions: tab → frame id → session. */
const frameSessions = new Map()
/**
 * Tabs whose page crashed (its renderer gone, a sad tab): nothing sent to the page answers until
 * the tab is reloaded, so the next call reloads it first.
 */
const crashed = new Set()
/** Tabs being closed by a session, whose "Leave site?" prompt is accepted. */
const closing = new Set()
/** The active tab before the current one, per window, to hand the person's view back after a popup. */
const previousActive = new Map()
const currentActive = new Map()

/** Runs best-effort background work without an unhandled rejection. */
function quietly(promise) {
  promise.catch((error) => {
    if (!String(error?.message ?? error).includes("No SW")) console.warn("switch hands:", error)
  })
}

/** Session name → { tabId, group, adopted, others, handBack, holdUntil }, mirrored in memory. */
let known = null

async function getSessions() {
  if (!known) {
    const { sessions } = await chrome.storage.local.get("sessions")
    known ??= sessions ?? {}
  }
  return known
}

// Session writes are serialized so parallel sessions don't overwrite each other's entries.
let sessionWrite = Promise.resolve()
function editSessions(edit) {
  sessionWrite = sessionWrite.then(async () => {
    const sessions = edit({ ...(await getSessions()) })
    known = sessions
    await chrome.storage.local.set({ sessions })
  })
  return sessionWrite
}

function setSession(name, meta) {
  return editSessions((sessions) => {
    if (meta == null) delete sessions[name]
    else sessions[name] = meta
    return sessions
  })
}

/** Every tab a session holds: its own, the ones it came through, and the person's it hands back. */
function tabsOf(meta) {
  return [meta.tabId, ...meta.others, ...(meta.handBack != null ? [meta.handBack] : [])]
}

async function tabExists(tabId) {
  return chrome.tabs.get(tabId).then(
    () => true,
    () => false,
  )
}

async function liveSession(name) {
  const meta = (await getSessions())[name]
  return meta && (attached.has(meta.tabId) || (await tabExists(meta.tabId))) ? meta : null
}

async function sessionOfTab(tabId) {
  const sessions = await getSessions()
  return Object.keys(sessions).find((name) => sessions[name].tabId === tabId) ?? null
}

// Chrome rejects tab edits while someone drags tabs, so group changes retry briefly, then give up: they're cosmetic.
let tabEdits = Promise.resolve()
function tabEdit(edit) {
  tabEdits = tabEdits.then(async () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        await edit()
        return
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
    }
  })
  return tabEdits
}

/** Puts the tab in the named group of its window, collapsed, creating the group if needed. */
function groupTab(tabId, title) {
  quietly(rememberGroup(title))
  return tabEdit(async () => {
    const tab = await chrome.tabs.get(tabId)
    const [existing] = await chrome.tabGroups.query({ title, windowId: tab.windowId })
    if (existing && tab.groupId === existing.id) return
    if (existing) {
      await chrome.tabs.group({ tabIds: tabId, groupId: existing.id })
      return
    }
    const groupId = await chrome.tabs.group({
      tabIds: tabId,
      createProperties: { windowId: tab.windowId },
    })
    await chrome.tabGroups.update(groupId, { title, color: "purple", collapsed: true })
  })
}

/** Remembers a group agents' tabs go in, so a tab left in it is known for one of theirs after its session has ended. */
async function rememberGroup(title) {
  const { groups = [] } = await chrome.storage.local.get("groups")
  if (!groups.includes(title)) await chrome.storage.local.set({ groups: [...groups, title] })
}

/** Takes an agent's tab out of the agents' group, for the person to keep. */
function ungroupTab(tabId) {
  return tabEdit(async () => {
    const tab = await chrome.tabs.get(tabId)
    if (tab.groupId !== NO_GROUP) await chrome.tabs.ungroup(tabId)
  })
}

/**
 * Attaches the debugger and sets the tab up. Focus emulation also keeps a
 * background tab rendering as if it were in front (timers, animation frames,
 * lazy content), which background tabs otherwise skip. A restarted worker
 * forgets its attachments while they live on, so "Another debugger" is retried
 * after detaching when the stale attachment is ours.
 */
async function attach(tabId) {
  // A new attachment has none of the last one's frame sessions.
  frameSessions.delete(tabId)
  try {
    await chrome.debugger.attach({ tabId }, "1.3")
  } catch (error) {
    if (!String(error?.message).includes("Another debugger")) throw error
    await chrome.debugger.detach({ tabId }).catch(() => {
      throw new Error(
        `tab ${tabId} is being debugged by something else (DevTools or another extension); close that, or use a new session`,
        { cause: error },
      )
    })
    await chrome.debugger.attach({ tabId }, "1.3")
  }
  const send = (method, params = {}) => chrome.debugger.sendCommand({ tabId }, method, params)
  // Chrome answers this itself, and says Inspector.targetCrashed first when the page's renderer is
  // gone (it crashed or was killed), which nothing sent to the page would ever answer.
  await send("Inspector.enable")
  if (crashed.has(tabId)) await revive(tabId)
  await send("Emulation.setFocusEmulationEnabled", { enabled: true })
  await send("Page.enable")
  await send("Runtime.enable")
  await send("Network.enable")
  // Never let a page open the OS file picker; uploads go through DOM.setFileInputFiles
  await send("Page.setInterceptFileChooserDialog", { enabled: true })
  attached.add(tabId)
}

/** How long a crashed tab's reload may take to finish before it's driven anyway (its page is there by then). */
const REVIVE_MS = 15_000

/** Reloads a crashed tab, which brings its page back in a new renderer, and waits for it to load. */
async function revive(tabId) {
  crashed.delete(tabId)
  const { promise, resolve } = Promise.withResolvers()
  const loaded = (id, change) => {
    if (id === tabId && change.status === "complete") resolve()
  }
  chrome.tabs.onUpdated.addListener(loaded)
  const timer = setTimeout(resolve, REVIVE_MS)
  try {
    await chrome.tabs.reload(tabId)
    await promise
  } finally {
    clearTimeout(timer)
    chrome.tabs.onUpdated.removeListener(loaded)
  }
}

/** The window agents' tabs open in: the last one used, or a new minimized one if there's none. */
async function agentWindow() {
  try {
    const window = await chrome.windows.getLastFocused({ windowTypes: ["normal"] })
    if (window?.id != null && !window.incognito) return window.id
  } catch {}
  const window = await chrome.windows.create({
    url: "about:blank",
    focused: false,
    state: "minimized",
  })
  return window.id
}

// One tab creation in flight per session, so concurrent first calls don't open two.
const creating = new Map()

async function createTab(session, group) {
  const windowId = await agentWindow()
  const tab = await chrome.tabs.create({ windowId, url: "about:blank", active: false })
  const meta = { tabId: tab.id, group: group ?? GROUP, adopted: false, others: [] }
  await setSession(session, meta)
  quietly(groupTab(tab.id, meta.group))
  return meta
}

/**
 * When the person last pressed Cancel on Chrome's debugging bar: they want it to stop, so agents wait
 * a while, unless the person says to go on (`consent`).
 */
let canceledAt = 0
const CANCEL_HOLDS_MS = 10 * 60_000

/** The session's tab with the debugger attached, opened in the background if it has none. */
async function ensure(session, group) {
  if (Date.now() - canceledAt < CANCEL_HOLDS_MS)
    throw new Error(
      "the person pressed Cancel on Chrome's debugging bar a few minutes ago, which stops your tabs: ask them before you drive this Chrome again, then call with person_asked (their words, and when)",
    )
  let meta = await liveSession(session)
  if (!meta) {
    if (!creating.has(session))
      creating.set(
        session,
        reopen(session, group).finally(() => creating.delete(session)),
      )
    meta = await creating.get(session)
  } else if (group && group !== meta.group && !meta.adopted) {
    meta = { ...meta, group }
    await setSession(session, meta)
    quietly(groupTab(meta.tabId, group))
  }
  if (crashed.has(meta.tabId)) await revive(meta.tabId)
  if (!attached.has(meta.tabId)) await attach(meta.tabId)
  used.set(session, Date.now())
  return meta
}

/** A session's tab, opened afresh when it has none, once the tabs its lost one came through are closed. */
async function reopen(session, group) {
  const meta = await liveSession(session)
  if (meta) return meta
  await release(session)
  return createTab(session, group)
}

/**
 * Ends a session: its own tabs close (or, kept open, leave the agents' group),
 * and a tab it took over is let go of where it is (it was never moved).
 */
async function release(session, keepOpen = false) {
  const meta = (await getSessions())[session]
  await setSession(session, null)
  used.delete(session)
  if (!meta) return
  const theirs = meta.adopted ? meta.tabId : meta.handBack
  for (const tabId of [meta.tabId, ...meta.others]) {
    if (!(await tabExists(tabId))) continue
    if (!keepOpen && tabId !== theirs) {
      await closeTab(tabId)
      continue
    }
    attached.delete(tabId)
    await chrome.debugger.detach({ tabId }).catch(() => undefined)
    if (tabId !== theirs) await ungroupTab(tabId)
  }
}

/**
 * Closes a session's tab, accepting a "Leave site?" prompt that would block it
 * forever (through the debugger, so an idle tab is attached again first).
 */
async function closeTab(tabId) {
  closing.add(tabId)
  try {
    if (!attached.has(tabId)) await attach(tabId).catch(() => undefined)
    await chrome.tabs.remove(tabId)
  } finally {
    closing.delete(tabId)
    attached.delete(tabId)
  }
}

async function frontTab() {
  const window = await chrome.windows.getLastFocused({ windowTypes: ["normal"] })
  const [tab] = await chrome.tabs.query({ active: true, windowId: window.id })
  if (!tab) throw new Error("no tab is in front in Chrome")
  return tab
}

const hands = {
  /** The person said to go on driving this Chrome: a Cancel on the debugging bar holds no longer. */
  async consent() {
    const held = Date.now() - canceledAt < CANCEL_HOLDS_MS
    canceledAt = 0
    return { held }
  },

  /** The session's tab, opened if needed: its id, address and title. */
  async open({ session, group }) {
    const meta = await ensure(session, group)
    const tab = await chrome.tabs.get(meta.tabId)
    return { tabId: tab.id, url: tab.url ?? "", title: tab.title ?? "", adopted: !!meta.adopted }
  },

  /** A debugger command in the session's tab, or in one of its other sites' frames (`frame`, from `frame`). */
  async cdp({ session, group, method, params, frame }) {
    const { tabId } = await ensure(session, group)
    const target = frame ? { tabId, sessionId: frame } : { tabId }
    return chrome.debugger.sendCommand(target, method, params ?? {})
  },

  /**
   * The debugger session of a frame from another site in the session's tab, which runs in a process
   * of its own; null when the frame runs in the page's own process.
   */
  async frame({ session, group, frameId }) {
    const { tabId } = await ensure(session, group)
    const found = () => frameSessions.get(tabId)?.get(frameId)
    for (const again of [false, true]) {
      if (found()) break
      const send = (autoAttach) =>
        chrome.debugger.sendCommand({ tabId }, "Target.setAutoAttach", {
          autoAttach,
          waitForDebuggerOnStart: false,
          flatten: true,
          filter: [{ type: "iframe" }],
        })
      // Frames attached before this worker started aren't announced again until auto-attach is turned off and on.
      if (again) await send(false)
      await send(true)
      const until = Date.now() + 2000
      while (!found() && Date.now() < until) await new Promise((r) => setTimeout(r, 50))
    }
    return found() ?? null
  },

  async tab({ session }) {
    const meta = await liveSession(session)
    if (!meta) return null
    const tab = await chrome.tabs.get(meta.tabId)
    return { tabId: tab.id, url: tab.url ?? "", title: tab.title ?? "", active: tab.active }
  },

  /** Every open tab, with its group, the session driving it, and which one is in front. */
  async tabs() {
    const [tabs, sessions, groups] = await Promise.all([
      chrome.tabs.query({}),
      getSessions(),
      chrome.tabGroups.query({}),
    ])
    const owners = new Map(Object.entries(sessions).map(([name, meta]) => [meta.tabId, name]))
    const titles = new Map(groups.map((g) => [g.id, g.title ?? ""]))
    const front = await frontTab().catch(() => null)
    return tabs.map((tab) => ({
      tabId: tab.id,
      title: tab.title ?? "",
      url: tab.url ?? "",
      front: tab.id === front?.id,
      group: titles.get(tab.groupId) ?? null,
      session: owners.get(tab.id) ?? null,
    }))
  },

  /** Takes over an open tab ("front": the one in front); releasing hands it back. */
  async adopt({ session, tabId }) {
    const tab = tabId === "front" ? await frontTab() : await chrome.tabs.get(Number(tabId))
    const sessions = await getSessions()
    const owner = Object.keys(sessions).find((name) => sessions[name].tabId === tab.id)
    if (owner != null && owner !== session)
      throw new Error(`tab ${tab.id} is already driven by session "${owner}"`)
    if (sessions[session] && sessions[session].tabId !== tab.id) await release(session)
    await setSession(session, { tabId: tab.id, group: null, adopted: true, others: [] })
    await ensure(session)
    return { tabId: tab.id, url: tab.url ?? "", title: tab.title ?? "" }
  },

  async release({ session, keepOpen }) {
    await release(session, keepOpen)
    return null
  },

  /** Brings the session's tab to the front. */
  async show({ session }) {
    const meta = await liveSession(session)
    if (!meta) throw new Error("this session has no tab open")
    const tab = await chrome.tabs.get(meta.tabId)
    if (tab.groupId !== NO_GROUP)
      await chrome.tabGroups.update(tab.groupId, { collapsed: false }).catch(() => undefined)
    await chrome.tabs.update(tab.id, { active: true })
    await chrome.windows.update(tab.windowId, { focused: true, state: "normal" })
    return { tabId: tab.id, url: tab.url ?? "", title: tab.title ?? "" }
  },

  /**
   * Sends the session's tab back behind the tab that was in front before `show`, and collapses its
   * group again, so the person's view is as it was.
   */
  async hide({ session }) {
    const meta = await liveSession(session)
    if (!meta) return null
    const tab = await chrome.tabs.get(meta.tabId)
    const back = previousActive.get(tab.windowId)
    if (tab.active && back != null && back !== tab.id && (await tabExists(back)))
      await chrome.tabs.update(back, { active: true })
    if (!meta.adopted && tab.groupId !== NO_GROUP)
      await chrome.tabGroups.update(tab.groupId, { collapsed: true }).catch(() => undefined)
    return null
  },

  /** Keeps a session's tab open (no idle close) until a time, for an ask whose button finishes the work there. */
  async hold({ session, until }) {
    const meta = await liveSession(session)
    if (!meta) throw new Error("this session has no tab open")
    await setSession(session, { ...meta, holdUntil: until })
    return null
  },
}

// Debugger events the appendage hears about, trimmed to what it uses.
const forwarded = {
  "Page.javascriptDialogOpening": (p) => p,
  "Page.javascriptDialogClosed": (p) => ({ result: p.result }),
  "Page.fileChooserOpened": (p) => ({
    mode: p.mode,
    backendNodeId: p.backendNodeId,
    frameId: p.frameId,
  }),
  "Page.frameNavigated": (p) => ({
    frameId: p.frame.id,
    parentId: p.frame.parentId ?? null,
    url: p.frame.url,
  }),
  "Page.frameStartedLoading": (p) => p,
  "Page.frameStoppedLoading": (p) => p,
  "Page.loadEventFired": () => ({}),
  "Page.domContentEventFired": () => ({}),
  "Runtime.executionContextsCleared": () => ({}),
  "Runtime.consoleAPICalled": (p) => ({
    type: p.type,
    args: (p.args ?? []).map((a) => a.value ?? a.description ?? a.type),
  }),
  "Runtime.exceptionThrown": (p) => ({
    text: p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? "",
  }),
  "Network.requestWillBeSent": (p) => ({
    requestId: p.requestId,
    url: p.request.url,
    method: p.request.method,
    type: p.type ?? null,
  }),
  "Network.responseReceived": (p) => ({
    requestId: p.requestId,
    status: p.response.status,
    mimeType: p.response.mimeType,
    type: p.type ?? null,
  }),
  "Network.loadingFinished": (p) => ({ requestId: p.requestId, bytes: p.encodedDataLength }),
  "Network.loadingFailed": (p) => ({
    requestId: p.requestId,
    error: p.errorText,
    canceled: !!p.canceled,
  }),
  "Inspector.targetCrashed": () => ({}),
}

chrome.debugger.onEvent.addListener(({ tabId, sessionId }, method, params) => {
  if (method === "Target.attachedToTarget" && params.targetInfo?.type === "iframe") {
    if (!frameSessions.has(tabId)) frameSessions.set(tabId, new Map())
    frameSessions.get(tabId).set(params.targetInfo.targetId, params.sessionId)
    return
  }
  if (method === "Target.detachedFromTarget") {
    for (const [frame, id] of frameSessions.get(tabId) ?? [])
      if (id === params.sessionId) frameSessions.get(tabId).delete(frame)
    return
  }
  // What a frame's own session reports isn't the page's.
  if (sessionId) return
  if (method === "Inspector.targetCrashed") crashed.add(tabId)
  if (
    method === "Page.javascriptDialogOpening" &&
    params.type === "beforeunload" &&
    closing.has(tabId)
  ) {
    quietly(chrome.debugger.sendCommand({ tabId }, "Page.handleJavaScriptDialog", { accept: true }))
    return
  }
  const trim = forwarded[method]
  if (!trim) return
  quietly(
    sessionOfTab(tabId).then((session) => {
      if (session != null) emit({ type: "event", session, method, params: trim(params) })
    }),
  )
})

chrome.debugger.onDetach.addListener(({ tabId }, reason) => {
  attached.delete(tabId)
  crashed.delete(tabId)
  frameSessions.delete(tabId)
  if (reason === "canceled_by_user") canceledAt = Date.now()
  quietly(
    sessionOfTab(tabId).then((session) => {
      if (session != null) emit({ type: "event", session, method: "detached", params: { reason } })
    }),
  )
})

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  if (currentActive.get(windowId) !== tabId)
    previousActive.set(windowId, currentActive.get(windowId))
  currentActive.set(windowId, tabId)
})

// A link that opens a new tab from a session's tab hands the session to the new tab. The earlier tab is remembered
// so release cleans it up too. A popup that came to the front is sent back, and the person gets their own tab again.
chrome.tabs.onCreated.addListener((tab) => quietly(handOff(tab)))

async function handOff(tab) {
  if (tab.openerTabId == null) return
  const sessions = await getSessions()
  const session = Object.keys(sessions).find((name) => sessions[name].tabId === tab.openerTabId)
  if (session == null) return
  const meta = sessions[session]
  await setSession(session, {
    ...meta,
    tabId: tab.id,
    adopted: false,
    others: [...meta.others, meta.tabId],
    ...(meta.adopted && { handBack: meta.tabId }),
  })
  if (tab.active && !meta.adopted) {
    const back = previousActive.get(tab.windowId)
    if (back != null && back !== tab.id) quietly(chrome.tabs.update(back, { active: true }))
  }
  if (!meta.adopted) quietly(groupTab(tab.id, meta.group ?? GROUP))
  emit({ type: "event", session, method: "moved", params: { tabId: tab.id } })
}

// Chrome gives a tab a new id when it swaps what's in it (a background tab discarded to save memory, a prerendered page
// taking over): the session follows its tab, or it would open another and leave this one behind for good.
chrome.tabs.onReplaced.addListener((added, removed) => quietly(replaced(added, removed)))

async function replaced(added, removed) {
  attached.delete(removed)
  const swap = (tabId) => (tabId === removed ? added : tabId)
  await editSessions((sessions) =>
    Object.fromEntries(
      Object.entries(sessions).map(([name, meta]) => [
        name,
        tabsOf(meta).includes(removed)
          ? {
              ...meta,
              tabId: swap(meta.tabId),
              others: meta.others.map(swap),
              ...(meta.handBack != null && { handBack: swap(meta.handBack) }),
            }
          : meta,
      ]),
    ),
  )
}

/** Whether the person is at this Mac, so a tab in front of them is theirs rather than one an agent left there. */
async function personHere() {
  return (await chrome.idle.queryState(AWAY_S)) === "active"
}

/** Lets idle tabs go: the debugger after a minute, the tab itself after half an hour. */
async function tidy() {
  const sessions = await getSessions()
  const now = Date.now()
  for (const [name, meta] of Object.entries(sessions)) {
    if (!(await tabExists(meta.tabId))) {
      // Its tab is gone (closed, or a popup that closed itself): the tabs it came through go with it.
      await release(name)
      continue
    }
    const idle = now - (used.get(name) ?? started)
    if (attached.has(meta.tabId) && idle > DETACH_AFTER_MS) {
      attached.delete(meta.tabId)
      await chrome.debugger.detach({ tabId: meta.tabId }).catch(() => undefined)
    }
    if (idle < CLOSE_AFTER_MS || (meta.holdUntil ?? 0) > now) continue
    const tab = await chrome.tabs.get(meta.tabId)
    const window = await chrome.windows.get(tab.windowId).catch(() => null)
    // A tab in front of the person is theirs now: it stays, out of the agents' group
    await release(name, meta.adopted || (tab.active && !!window?.focused && (await personHere())))
  }
  await sweep(await getSessions(), now)
}

/**
 * Closes the tabs left in the agents' groups that no session holds, half an hour after they were first seen so
 * (kept in storage, as a restarted worker forgets): a session that lost track of its tab, or a page a stray tab opened.
 */
async function sweep(sessions, now) {
  const held = new Set(Object.values(sessions).flatMap(tabsOf))
  const { groups = [], strays = {} } = await chrome.storage.local.get(["groups", "strays"])
  const titles = new Set([GROUP, ...groups])
  const ours = new Set(
    (await chrome.tabGroups.query({})).filter((g) => titles.has(g.title ?? "")).map((g) => g.id),
  )
  const left = (await chrome.tabs.query({})).filter(
    (tab) => ours.has(tab.groupId) && !held.has(tab.id),
  )
  const since = Object.fromEntries(left.map((tab) => [tab.id, strays[tab.id] ?? now]))
  await chrome.storage.local.set({ strays: since })
  for (const tab of left) {
    if (now - since[tab.id] < CLOSE_AFTER_MS) continue
    const window = await chrome.windows.get(tab.windowId).catch(() => null)
    if (tab.active && window?.focused && (await personHere())) await ungroupTab(tab.id)
    else await closeTab(tab.id).catch(() => undefined)
  }
}

chrome.alarms.create("tidy", { periodInMinutes: 0.5 })
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "tidy") quietly(tidy())
})
