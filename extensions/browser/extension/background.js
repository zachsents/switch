// The browser extension's half in Chrome (or another Chromium browser), over native messaging to
// its half on this Mac. Eyes: it reports the page in front, and whether an agent is driving it.
// Hands (hands.js): agents drive tabs here through the debugger. Ported from Switchboard's
// extension.

importScripts("hands.js")

const HOST = "ax.switch.browser"
let port = null

function connect() {
  if (port) return
  try {
    port = chrome.runtime.connectNative(HOST)
  } catch {
    setTimeout(connect, 30000)
    return
  }
  port.onMessage.addListener(onMessage)
  port.onDisconnect.addListener(() => {
    port = null
    setTimeout(connect, 10000)
  })
  // The Mac half asks for a reload when it has written newer files than these (it stamps their hash as version_name).
  const manifest = chrome.runtime.getManifest()
  port.postMessage({
    type: "hello",
    version: manifest.version_name ?? manifest.version,
    release: manifest.version,
  })
}

// The browser stops an idle worker, and the retry above with it: the alarm wakes it, and it connects again as it starts.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "reconnect" && !port) connect()
})
chrome.alarms
  .get("reconnect")
  .then((alarm) => alarm || chrome.alarms.create("reconnect", { periodInMinutes: 1 }))

/** Sends to the Mac half, if it's there. */
function emit(message) {
  port?.postMessage(message)
}

/**
 * Whether an agent is driving the tab: browser agents keep their tabs in a tab group with a
 * debugger attached. DevTools attaches one too, so the group is what tells the person's own tabs apart.
 */
async function driven(tab) {
  if (tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) return false
  const targets = await chrome.debugger.getTargets()
  return targets.some((target) => target.tabId === tab.id && target.attached)
}

/** Says what's in front; when none of the windows it can see is focused, it says so instead. */
async function report() {
  if (!port) return
  const window = await chrome.windows.getLastFocused().catch(() => null)
  if (!window?.focused) return emit({ type: "page", hidden: true })
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (tab)
    emit({
      type: "page",
      url: tab.url || "",
      title: tab.title || "",
      agent: await driven(tab),
      hidden: false,
    })
}

chrome.tabs.onActivated.addListener(report)
chrome.tabs.onUpdated.addListener((_, change) => {
  if (change.url || change.title || change.groupId !== undefined) report()
})
chrome.windows.onFocusChanged.addListener(report)

/** Reloads from the files on disk, at most once in ten minutes, so files that failed to update can't loop it. */
async function reloadOnce() {
  const { reloadedAt } = await chrome.storage.local.get("reloadedAt")
  if (reloadedAt && Date.now() - reloadedAt < 10 * 60_000) return
  await chrome.storage.local.set({ reloadedAt: Date.now() })
  chrome.runtime.reload()
}

async function onMessage(message) {
  if (message.type === "call") return answer(message)
  if (message.type === "reload") return reloadOnce()
}

/** One of the hands' calls, answered with its result or why it failed. */
async function answer({ id, method, params }) {
  try {
    const handler = hands[method]
    if (!handler) throw new Error(`the extension has no ${method}`)
    emit({ type: "reply", id, result: (await handler(params ?? {})) ?? null })
  } catch (error) {
    emit({ type: "reply", id, error: error instanceof Error ? error.message : String(error) })
  }
}

connect()
