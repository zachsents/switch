# switch-ext-secrets

The user's passwords, logins, API keys, cards, notes, authenticator keys and SSH keys in one
vault, encrypted at rest and end to end to the user's own devices. The agent uses them without
ever seeing them: a browser field filled, a command's environment, a file, an HTTP header. Each use
is checked against grants and kept in an audit. The user browses, reveals, copies and edits them on
the Mac and iPhone, and the iPhone fills them in Safari and apps.

A [Switch](https://switch.ax) extension, built on [switch-ext-kit](../../packages/kit).

## Install

Ask Switch's agent to install `github:zachsents/switch` with path `extensions/secrets`, or add it in the desktop's Extensions
view. It runs on the core's always-on machine (`needs: ["always-on"]`), a Mac: the vault key is in
that Mac's login Keychain. Its store is `$SWITCH_SECRETS_DIR`, else `$SWITCH_DIR/secrets`, else
`~/.switch/secrets`.

## The vault

An **item** is a kind, a title, a name the agent refers to it by, and fields:

| kind | its fields |
| --- | --- |
| `login` | `username`, `password`, `totp`, any number of `urls` |
| `password` | `password` |
| `api-key` | `credential`, `username`; `urls` are the hosts it may be sent to |
| `card` | `holder`, `number`, `cvc`, `month`, `year`, `expiry`, `pin` |
| `note` | `notes` |
| `ssh-key` | `private_key`, `public_key`, `passphrase` |
| `identity` | `name`, `email`, `phone`, `address`, `ssn`, `passport`, `license` |
| `file` | (later) |

Every item may also have `notes` and custom fields. A field is `{ id, label, type, value }`; its
type says whether it's concealed (`password`, `concealed`, `totp`, `card-number`, `cvc`, `pin`,
`ssn`, `private-key`) or plain (`text`, `email`, `url`, `phone`, `date`, `month`, `year`). Items
also have `tags`, one `folder` ("Work/Clients"), the Switch `spaces` they belong to, `favorite`,
and `created`/`updated`/`used`. Every change keeps the item as it was in its **history**, so old
values (an old password) can be seen and restored. Deleting moves an item to the trash; purging
it removes it and its history.

An item's **name** is lowercase letters, digits and `. _ / @ -` (`github`, `card/main`). A
**reference** is `name` (its main secret: a login's password, a key's credential) or
`name.field` (`card/main.number`, `github.totp`, the current code). Templates write
`{{name.field}}`.

## Crypto

- **Vault key** `VK`: 32 random bytes, made once, kept in the vault Mac's login Keychain (service
  `Switch secrets`, account `vault:<vault id>`, beside this extension's own key pair), piped to
  `security -i` so it's never in argv. A Keychain that can't be read is an error, never a new key.
  Rotated (a new key version) whenever a device is revoked; a rotation cut short finishes at the
  next start.
- **Subkeys**, HKDF-SHA256 over `VK` with an empty salt and 32 bytes out: the item key
  (`info` = `switch-secrets-v1 items`) and the approval key (`switch-secrets-v1 approve`).
- **An item at rest and in sync** is one blob: `base64(nonce[12] ‖ AES-256-GCM(item key, JSON))`
  with additional data `switch-secrets-v1\0<vault id>\0<item id>\0<key version>`. The JSON is the
  whole item (`Item` in `src/model.ts`). Its history rows are blobs the same way. The SQLite file
  holds only blobs and what's needed to sync them: no title, URL or username in the clear.
- **Sealing** is switch-ext-kit's HPKE (RFC 9180 base mode: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256,
  AES-256-GCM; CryptoKit's `.Curve25519_SHA256_AES_GCM_256`), its `info` being
  `switch-sealed-v1\0<item>\0<use>`. Every sealing here names its own `item` and `use`:
  - the vault key to a device: item `device:<device id>`, use `vault-key:<vault id>:<key version>`,
    the secret `base64(VK)`;
  - a release to an extension: item `release:<release id>`, use `<extension>:<item id>`, the secret a JSON
    object of field id → value;
  - a deposit from an extension to this one: item `deposit:<deposit id>`, use `<extension>`, the secret the
    item JSON (`Draft` in `src/model.ts`);
  - a sealed ask's answer: as switch-ext-kit's sealed asks make it.
- **This extension's key** (an X25519 pair for deposits) is in the same Keychain item.
- **Proofs.** What only the user may do (approve a device or an extension, revoke, change grants, purge)
  carries `proof` = `base64(HMAC-SHA256(approval key, statement))`, made on an enrolled device,
  which alone holds `VK`. The statement is the NUL-joined words of the call, listed with each tool
  below. Until a device is enrolled, approvals go through the user's queue (an approval item) or
  the vault Mac's own terminal (`bun src/main.ts approve <code>`, which hands the code to the
  running extension; `status` lists devices and extensions).

## Devices and sync

1. A device (the Mac app, the iPhone app, which shares its keys with its AutoFill extension)
   makes an X25519 key pair once, its private half in that device's Keychain (on the iPhone,
   readable only after Face ID), and enrolls: `device_enroll { name, kind, key }` → `{ device,
   code }`. The code (6 digits, from `SHA-256(key)`) shows on the device.
2. It's approved: from an enrolled device (`device_approve { device, proof }` over
   `approve-device\0<device>\0<key>`), or, while none is, in the user's queue, where the same code
   shows. The extension then seals `VK` to the device's key.
3. `sync { device, since, version? }` → `{ vault, status, seq, keyVersion, key?, items: [{ id, seq,
   deleted, blob }], devices, extensions, grants }` (devices and extensions with their public keys): every
   item changed after `since` (all of them from 0, or when `version` isn't the key version now).
   `key` (the sealed `VK`) comes when `since` is 0 or the key version moved. A totp field's value
   is an `otpauth://` link; an item's notes count as concealed. The core relays only ciphertext.
   The event `secrets.changed { seq }` says when to sync again.
4. A device writes by sealing the item itself: `put { device, id, blob }`. The extension checks it opens
   under the item key (only a holder of `VK` can make one), keeps what it was in history, and
   bumps `seq`. `history { device, id }` → its old blobs. `remove { device, id, purge?, proof? }`
   trashes, restores (`restore: true`) or, with a proof over `purge\0<id>`, purges.
5. Revoking (`device_revoke { device, proof }` over `revoke-device\0<device>`) drops its key and
   rotates `VK`: every blob is sealed again under the new key version and the new `VK` sealed to
   each device left.

A device records what the user did with a secret there (`used { device, item, field, use }`: reveal,
copy, autofill, export) so the audit is whole.

## The agent's tools

- `list { query?, kind?, tag?, folder?, space?, url? }` and `get { item }`: items without their
  concealed values (what they hold, by field label and type).
- `save { … }`: makes or changes an item's plain parts, a generated password
  (`generate: { field?, length?, style? }`), or a value from a file on the vault Mac
  (`from_file: { field, path }`). The agent never sets a concealed value itself.
- `ask { title, kind, name?, field?, urls?, username?, why, space }`: a sealed ask for a secret the
  user types; it's kept straight from their device.
- `run { command, env?, files?, stdin?, cwd?, timeout?, why, space? }`: runs a command on the vault
  Mac with references in its environment (`env: { "TOKEN": "github.password" }`), in files made for
  the run and removed after (`files: [{ name, content }]`, `$SECRETS_FILES` their folder), and in
  stdin, as templates. Every vault value is redacted from its output.
- `http { url, method?, headers?, query?, body?, why, space? }`: a request with templates in its
  headers, query and body, sent only to hosts each referenced item allows (its `urls`); the response
  redacted.
- `write_file { path, content, mode?, why }`: a file kept on the vault Mac from a template.
- `delete { item }`, `import { source, path?, confirm? }`, `audit { item?, limit? }`, `grants`.

## For other extensions

An extension that fills or sends secrets (the browser) registers a key: `extension_register { extension, key }`,
approved like a device (`extension_approve { extension, proof }` over `approve-extension\0<extension>\0<key>`). Then
`release { extension, item | ref, fields?, url?, use, why?, space? }` → `{ id, item, name, title, labels,
fields, enc, ct }`, the values sealed to it (a totp field as its code now), after the
grants allow the extension that use and, for an item with `urls`, the page's `url` matches one. It keeps
what it learns with `deposit { extension, id, enc, ct }`. These go through the core's
`/widgets/secrets/<tool>`, as clients call it.

## Grants

`{ subject, scope, uses }`: `subject` is `extension:<name>`, `space:<id>` or `agent` (any space);
`scope` is `all`, `item:<id>`, `tag:<tag>`, `folder:<folder>` or `kind:<kind>`; `uses` are
`fill`, `env`, `file`, `http`. An item that belongs to spaces is used by the agent only from them;
one that belongs to none, from any. The vault starts with `agent` and `extension:browser` granted every
use on `all`; the user narrows them in the apps (`grant { device, proof, op, grant }`, its
statements `grant\0add\0<subject>\0<scope>\0<uses, comma-joined>` and `grant\0remove\0<id>`).

## Approvals

An item marked `requires_approval` (save's, kept in the `locks` table beside the sealed items, so a
device's edit can't drop it) is used for nothing (`env`, `file`, `http`, an extension's `release`)
until the user approves that use with their passkey. The call opens an approval in their queue
(`passkey: "passkey"`, which the core links to `/p/passkey/<token>` on the pages' public address)
and waits up to four minutes; past that it answers which item to wait on, and the same call again
finds the approval once it's given. On the page Face ID or Touch ID signs a challenge this
extension issued (`passkey { step: "options" | "verify" }`); it checks the signature, origin,
relying party and user verification against the passkey it keeps (`src/passkeys.ts`) before the
use goes ahead. An approval is for one request (its digest), used once within 15 minutes, or for
every use of those items by that caller from that space for 15 minutes ("Approve 15 min"). The
vault's first passkey is made at its first approval; after that only a passkey it has signs.
Taking the lock off (`requires_approval: false`) is approved the same way.

## Audit

Every use (`fill`, `env`, `file`, `http`, `reveal`, `copy`, `autofill`, `export`, `ask`, `save`,
`delete`, `import`) and every refusal: when, which item and field, who (`agent`, `extension:<name>`,
`device:<id>`), from which space, what for, and where it went (a host, a command's name, a file).
Kept in the extension's own store, never in the brain.

## Imports

Each runs once and shows what it would add before it does (`import { source }` then
`import { source, confirm }`): `chrome` (Chrome's exported passwords CSV), `apple` (Passwords'
exported CSV), `bitwarden` (unencrypted JSON), `1password` (CSV), `csv`, `switchboard` (the old
macOS appendage's secrets and accounts) and `browser` (what switch-ext-browser kept before this).

## Develop

```sh
bun install
bun run check
bun start   # serves MCP on stdio
```
