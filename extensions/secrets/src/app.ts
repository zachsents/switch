// The secrets extension: the vault (store.ts) as tools. The agent's tools never return a concealed
// value; they use one (a command's environment, a file, a request) or ask the user for one. The
// rest are for the user's devices and other extensions, which only ever get ciphertext: called
// through the core (`/widgets/secrets/<tool>`), never offered to the agent.
import { Effect, Queue, Schema } from "effect"
import { AppEvents, defineApp, defineEvent, tool } from "switch-ext-kit"

import { answer, AnswerInput, approval, ask, AskInput } from "./asks.ts"
import { ALL_SOURCES, preview, taken } from "./legacy.ts"
import { KINDS } from "./model.ts"
import * as ops from "./ops.ts"
import * as store from "./store.ts"
import type { Vault } from "./store.ts"
import { USES } from "./use.ts"

const APP = "secrets"

/** The vault changed: its new seq. Devices sync from the one they have. */
export const Changed = defineEvent("secrets.changed", 1, Schema.Struct({ seq: Schema.Finite }))

/** Every this often, as its manifest's `heartbeat` promises. */
const BEAT = 5 * 60_000

/** How the vault is, beaten by the extension's background layer, so it stops when that does. */
export const Heartbeat = defineEvent(
  "secrets.heartbeat",
  1,
  Schema.Struct({
    entity: Schema.Literal("sense:secrets"),
    summary: Schema.String,
    facts: Schema.Struct({
      failing: Schema.NullOr(Schema.String),
      items: Schema.Finite,
      devices: Schema.Finite,
    }),
  }),
)

/** Beats `secrets.heartbeat` every BEAT: its items, its active devices, and a vault it can't read. */
export const heartbeat = (v: Vault) =>
  Effect.gen(function* beating() {
    const events = yield* AppEvents
    const beat = Effect.gen(function* one() {
      let failing: string | null = null
      let active = 0
      try {
        active = store.devices(v).filter((d) => d.status === "active").length
      } catch (error) {
        failing = `vault unreadable: ${error instanceof Error ? error.message : String(error)}`
      }
      yield* events.emit(
        Heartbeat.make({
          entity: "sense:secrets",
          summary: `${v.items.size} items, ${active} devices`,
          facts: { failing, items: v.items.size, devices: active },
        }),
      )
    })
    for (;;) {
      yield* Effect.ignore(beat, { log: "Warn" })
      yield* Effect.sleep(`${BEAT} millis`)
    }
  })

const task = <A>(f: () => Promise<A>) =>
  Effect.tryPromise({ try: f, catch: (e) => (e instanceof Error ? e : new Error(String(e))) })

const opt = Schema.optionalKey
const optString = opt(Schema.String)

/** Emits `secrets.changed` after each write, a burst as one. */
export const announce = Effect.gen(function* announcing() {
  const events = yield* AppEvents
  const seqs = yield* Queue.unbounded<number>()
  ops.onChange((seq) => {
    Queue.offerUnsafe(seqs, seq)
  })
  for (;;) {
    const first = yield* Queue.take(seqs)
    yield* Effect.sleep("200 millis")
    const rest = yield* Queue.clear(seqs)
    const seq = Math.max(first, ...rest)
    yield* Effect.ignore(events.emit({ type: Changed.type, payload: { seq } }))
  }
})

/** A write: after every one before it. */
const w = <A>(f: () => Promise<A>) => task(async () => await ops.serial(f))

const sync = <A>(f: () => A) =>
  Effect.try({ try: f, catch: (e) => (e instanceof Error ? e : new Error(String(e))) })

export const secretsApp = (v: Vault) => {
  const listTool = tool(
    "list",
    {
      description:
        "The user's vault: logins, passwords, API keys, cards, notes, SSH keys and identities, by name, title, URLs, username, tags, folder and spaces. Concealed fields show only their label and whether they're set, never a value. query matches words; url gives the logins and keys for that page or host; space narrows to items usable there; trashed lists the trash.",
      readOnly: true,
      input: Schema.Struct({
        query: optString,
        kind: opt(Schema.Literals(KINDS)),
        tag: optString,
        folder: optString,
        space: optString,
        url: optString,
        trashed: opt(Schema.Boolean),
      }),
    },
    (input) => sync(() => ({ items: ops.list(v, input) })),
  )

  const getTool = tool(
    "get",
    {
      description:
        "One item by name or id: its fields (concealed ones by label only), URLs, tags, folder, spaces, how many old versions it has, and its last uses.",
      readOnly: true,
      input: Schema.Struct({ item: Schema.String }),
    },
    (input) => task(async () => await ops.get(v, input.item)),
  )

  const saveTool = tool(
    "save",
    {
      description: `Makes an item or changes one (item: its name or id). Plain parts only: title, name (lowercase, how it's referred to), kind (${KINDS.join(", ")}), username, urls (where a login is filled and the only hosts an API key is sent to), tags, folder ("Work/Clients"), spaces (the only spaces it's used from; none: all), favorite, fields [{id, label?, type?, value}] that aren't concealed, restore (out of the trash). A concealed value never comes from you: generate {field?, style?: random | apple | pin, length?, digits?, symbols?} makes one (a new password, kept; the old one stays in its history), from_file {field, path} reads one from a file on the vault's Mac, and ask asks the user. Returns the item's outline.`,
      input: ops.SaveInput,
    },
    (input) => w(async () => await ops.save(v, input, "agent")),
  )

  const deleteTool = tool(
    "delete",
    {
      description:
        "Moves an item to the trash (save with restore takes it back). Purging is the user's.",
      input: Schema.Struct({ item: Schema.String }),
    },
    (input) => w(async () => await ops.trash(v, input.item, "agent")),
  )

  const askTool = tool(
    "ask",
    {
      description:
        "Asks the user for a secret through a sealed card on their Mac or iPhone: what they type is sealed on their device and goes straight into the vault, never through you, a chat or the brain. title is the card's (\"Bank login password\"); why says what it's for. It fills field (else the kind's main secret) of item, or of a new item made with kind, name, username, urls and the space. Returns the reference to use once it's answered; the vault says secrets.changed when it is.",
      input: AskInput,
    },
    (input) => ask(v, input),
  )

  const runTool = tool(
    "run",
    {
      description: `Runs a command on the vault's Mac with secrets in it by reference, never seen by you: env {"API_TOKEN": "openai"} (a reference: an item's name for its main secret, or name.field like card/main.number or github.totp for the code now; or a template with {{ref}} in it), files [{name, content}] made for the run in $SECRETS_FILES (0600, removed after), and stdin, both templates. command is a shell line or an argv; never a secret in it. Output comes back with every vault value hidden. why says what it's for (kept in the audit); space is the one you're working in.`,
      input: ops.RunInput,
      speaks: true,
    },
    (input) => task(async () => await ops.run(v, input)),
  )

  const httpTool = tool(
    "http",
    {
      description: `An HTTPS request with secrets in its headers, query or body as {{ref}} templates ({"Authorization": "Bearer {{openai}}"}), sent only to a host the item lists in its urls. The response comes back with every vault value hidden; redirects aren't followed. why says what it's for.`,
      input: ops.HttpInput,
      speaks: true,
    },
    (input) => task(async () => await ops.http(v, input)),
  )

  const writeFileTool = tool(
    "write_file",
    {
      description:
        "Writes a file on the vault's Mac from a template with {{ref}} secrets in it (an .npmrc, a config), mode 0600 unless given. It stays: say why.",
      input: ops.WriteFileInput,
    },
    (input) => task(async () => await ops.writeFile(v, input)),
  )

  const importTool = tool(
    "import",
    {
      description: `Takes in another password manager's export or an old store, once: first without confirm it says what it would add (counts and titles, nothing secret), then with confirm (the token it gave) it adds them. source: chrome (Chrome's exported passwords CSV), apple (Passwords' exported CSV), bitwarden (unencrypted JSON), 1password (CSV), csv (any with a header), browser (what switch-ext-browser kept before the vault), switchboard (old Switchboard's macOS appendage). path: the export's path on the vault's Mac; else the newest in ~/Downloads. The export file is left where it was: it holds every password in the clear, so ask the user to delete it.`,
      input: Schema.Struct({
        source: Schema.Literals(ALL_SOURCES),
        path: optString,
        confirm: optString,
      }),
    },
    (input) =>
      w(async () => {
        if (input.confirm === undefined) {
          return await preview(v, input.source, input.path)
        }
        const p = taken(input.confirm)
        const made = []
        for (const d of p.previous) {
          const item = ops.fromDraft(v, d, `import:${p.source}`, false)
          await store.writeItem(v, item)
          made.push(item)
        }
        for (const d of p.drafts) {
          const earlier = made.find((m) => m.name === d.name)
          const item = ops.fromDraft(
            v,
            earlier ? { ...d, into: earlier.id } : d,
            `import:${p.source}`,
            false,
          )
          await store.writeItem(v, item)
          store.record(v, {
            item: item.id,
            name: item.name,
            field: "",
            use: "import",
            who: "agent",
            space: "",
            why: p.source,
            target: p.file,
            ok: true,
            reason: "",
          })
        }
        ops.touched(v)
        return { imported: p.drafts.length, already: p.skipped }
      }),
  )

  const auditTool = tool(
    "audit",
    {
      description:
        "Who used which secret, when, how (fill, env, file, http, reveal, copy, autofill, export, ask, save, delete, import) and for what, refusals too: for one item or all, newest first.",
      readOnly: true,
      input: Schema.Struct({ item: optString, limit: opt(Schema.Finite) }),
    },
    (input) =>
      sync(() => ({
        uses: store.audit(
          v,
          input.item === undefined
            ? null
            : ([...v.items.values()].find((i) => i.name === input.item)?.id ?? input.item),
          Math.min(input.limit ?? 50, 500),
        ),
      })),
  )

  const grantsTool = tool(
    "grants",
    {
      description:
        "What may use which secrets: each grant's subject (agent, space:<id>, extension:<name>), scope (all, item:, tag:, folder:, kind:) and uses (fill, env, file, http); the devices that hold the vault and the extensions allowed to fill. Only the user changes them, in the apps.",
      readOnly: true,
    },
    () =>
      sync(() => ({
        grants: store.grants(v),
        devices: store.devices(v).map(({ key: _, ...d }) => d),
        extensions: store.extensions(v).map(({ key: _, ...s }) => s),
      })),
  )

  // For devices and extensions: through the core's /widgets, never offered to the agent.

  const info = tool(
    "info",
    {
      description: "The vault's id, key version, seq and this extension's public key.",
      readOnly: true,
      appOnly: true,
    },
    () =>
      sync(() => ({
        vault: v.keys.vault,
        keyVersion: v.keys.version,
        seq: store.seqOf(v),
        extensionKey: v.extensionKey,
        items: [...v.items.values()].filter((i) => i.trashed === 0).length,
        devices: store.devices(v).filter((d) => d.status === "active").length,
      })),
  )

  const enrollTool = tool(
    "device_enroll",
    {
      description: "A device asks to hold the vault: its name, kind and X25519 public key.",
      appOnly: true,
      input: Schema.Struct({ name: Schema.String, kind: Schema.String, key: Schema.String }),
    },
    (input) =>
      Effect.gen(function* enrolling() {
        const made = yield* w(async () => await ops.enroll(v, input.name, input.kind, input.key))
        yield* approval(v, { device: made.device }, `Let ${input.name} hold your vault?`, made.code)
        return made
      }),
  )

  const proofInput = { proof: optString }

  const approveDeviceTool = tool(
    "device_approve",
    {
      description: "Approves a waiting device, with a proof from one already enrolled.",
      appOnly: true,
      input: Schema.Struct({ device: Schema.String, ...proofInput }),
    },
    (input) => w(async () => await ops.approveDevice(v, input.device, input.proof)),
  )

  const revokeDeviceTool = tool(
    "device_revoke",
    {
      description: "Revokes a device and rotates the vault key, with a proof.",
      appOnly: true,
      input: Schema.Struct({ device: Schema.String, ...proofInput }),
    },
    (input) => w(async () => await ops.revokeDevice(v, input.device, input.proof)),
  )

  const syncTool = tool(
    "sync",
    {
      description:
        "A device's sync: what changed after `since`, sealed, and its sealed vault key when it needs it.",
      readOnly: true,
      appOnly: true,
      input: Schema.Struct({
        device: Schema.String,
        since: opt(Schema.Finite),
        version: opt(Schema.Finite),
      }),
    },
    (input) => sync(() => ops.sync(v, input.device, input.since ?? 0, input.version)),
  )

  const putTool = tool(
    "put",
    {
      description: "A device keeps an item it sealed.",
      appOnly: true,
      input: Schema.Struct({ device: Schema.String, id: Schema.String, blob: Schema.String }),
    },
    (input) => w(async () => await ops.put(v, input.device, input.id, input.blob)),
  )

  const removeTool = tool(
    "remove",
    {
      description: "A device purges an item and its history, with a proof.",
      appOnly: true,
      input: Schema.Struct({ device: Schema.String, id: Schema.String, ...proofInput }),
    },
    (input) => w(async () => await ops.remove(v, input.device, input.id, input.proof)),
  )

  const historyTool = tool(
    "history",
    {
      description: "An item's earlier versions, sealed.",
      readOnly: true,
      appOnly: true,
      input: Schema.Struct({ device: Schema.String, id: Schema.String }),
    },
    (input) => sync(() => ops.history(v, input.device, input.id)),
  )

  const usedTool = tool(
    "used",
    {
      description:
        "A device says what the user did with a secret there: reveal, copy, autofill, export.",
      appOnly: true,
      input: Schema.Struct({
        device: Schema.String,
        item: Schema.String,
        field: optString,
        use: Schema.Literals(["reveal", "copy", "autofill", "export"]),
      }),
    },
    (input) => sync(() => ops.used(v, input.device, input.item, input.field ?? "", input.use)),
  )

  const grantTool = tool(
    "grant",
    {
      description: "A device adds or removes a grant, with a proof.",
      appOnly: true,
      input: Schema.Struct({
        device: Schema.String,
        op: Schema.Literals(["add", "remove"]),
        id: optString,
        subject: optString,
        scope: optString,
        uses: opt(Schema.Array(Schema.Literals(USES))),
        ...proofInput,
      }),
    },
    (input) =>
      w(
        async () =>
          await ops.changeGrant(v, input.device, input.proof, input.op, {
            ...(input.id !== undefined && { id: input.id }),
            ...(input.subject !== undefined && { subject: input.subject }),
            ...(input.scope !== undefined && { scope: input.scope }),
            ...(input.uses !== undefined && { uses: input.uses }),
          }),
      ),
  )

  const registerTool = tool(
    "extension_register",
    {
      description:
        'An extension that fills or sends secrets gives its X25519 key, and `label`, what the user knows it as ("the Mac extension on the Mac mini"); it waits to be allowed. Returns the vault\'s key for deposits.',
      appOnly: true,
      input: Schema.Struct({
        extension: Schema.String,
        key: Schema.String,
        label: Schema.optionalKey(Schema.String),
      }),
    },
    (input) =>
      Effect.gen(function* registering() {
        const made = yield* w(
          async () => await ops.registerExtension(v, input.extension, input.key),
        )
        if (made.status === "pending") {
          const label = input.label ?? `the ${input.extension} extension`
          yield* approval(
            v,
            { extension: input.extension },
            `Let ${label} use your secrets?`,
            made.code,
          )
        }
        return made
      }),
  )

  const approveExtensionTool = tool(
    "extension_approve",
    {
      description: "Allows a waiting extension, with a proof.",
      appOnly: true,
      input: Schema.Struct({ extension: Schema.String, ...proofInput }),
    },
    (input) => w(async () => await ops.approveExtension(v, input.extension, input.proof)),
  )

  const revokeExtensionTool = tool(
    "extension_revoke",
    {
      description: "Stops an extension using the vault, with a proof.",
      appOnly: true,
      input: Schema.Struct({ extension: Schema.String, ...proofInput }),
    },
    (input) => w(async () => await ops.revokeExtension(v, input.extension, input.proof)),
  )

  const releaseTool = tool(
    "release",
    {
      description:
        "Fields of an item sealed to an allowed extension, for one use, after the grants and its URLs allow it.",
      appOnly: true,
      input: ops.ReleaseInput,
    },
    (input) => task(async () => await ops.release(v, input)),
  )

  const depositTool = tool(
    "deposit",
    {
      description: "An allowed extension keeps an item (a Draft) it sealed to the vault's key.",
      appOnly: true,
      input: ops.DepositInput,
    },
    (input) => w(async () => await ops.deposit(v, input)),
  )

  const answerTool = tool(
    "answer",
    {
      description: "The core hands back an ask this extension raised.",
      appOnly: true,
      input: AnswerInput,
    },
    (input) =>
      answer(v, input, async (device, extension) => {
        await ops.serial(async () => {
          const d = device === undefined ? null : store.device(v, device)
          if (d && d.status === "pending") {
            await store.approveDevice(v, d)
          }
          const s = extension === undefined ? null : store.extension(v, extension)
          if (s && s.status === "pending") {
            store.putExtension(v, { ...s, status: "active", approved: Date.now() })
          }
          ops.touched(v)
        })
      }),
  )

  return defineApp({
    name: APP,
    version: "1",
    instructions:
      "The user's vault of passwords, keys, cards and notes. You never see a secret's value: list and get show what's kept; run, http and write_file put secrets into a command, a request or a file by reference (an item's name, or name.field); the browser's sign_in and fill_secret fill them into pages; ask asks the user for one through a sealed card; save makes items and generates passwords. Every use is checked against the user's grants and kept in the audit.",
    tools: [
      listTool,
      getTool,
      saveTool,
      deleteTool,
      askTool,
      runTool,
      httpTool,
      writeFileTool,
      importTool,
      auditTool,
      grantsTool,
      info,
      enrollTool,
      approveDeviceTool,
      revokeDeviceTool,
      syncTool,
      putTool,
      removeTool,
      historyTool,
      usedTool,
      grantTool,
      registerTool,
      approveExtensionTool,
      revokeExtensionTool,
      releaseTool,
      depositTool,
      answerTool,
    ],
    events: [Changed, Heartbeat],
  })
}
