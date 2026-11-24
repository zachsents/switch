# Permissions

macOS grants (TCC) belong to a signed identity: a bundle id plus its designated requirement (the
Developer ID team). Every deploy re-signs with the same id and Developer ID, so a grant made once
survives every deploy. The ids and the team are instance data in the server's `~/.switch/deploy.json`
(`hostId`, `appId`, `identity`, `team`), not in this repo.

## Who holds what

- **Host bundle**, `/Applications/Switch Host.app`, signed as `hostId`: the extension host (on the server,
  the core with its host inside). Every extension and Swift helper (`packages/**/macos/<name>.swift`, built
  into `Contents/MacOS`) runs as its child, so its grants are theirs.
- **Desktop app**, `/Applications/Switchboard.app`, signed as `appId`: the client. It only renders.

Check which id holds grants on a Mac, from a shell with Full Disk Access:

```sh
sqlite3 -readonly "/Library/Application Support/com.apple.TCC/TCC.db" \
  "select service, client, auth_value from access where client like '<id prefix>%'"
sqlite3 -readonly ~/Library/Application\ Support/com.apple.TCC/TCC.db \
  "select service, client, auth_value, indirect_object_identifier from access where client like '<id prefix>%'"
```

`auth_value` 2 is allowed, 0 denied. Check that a deploy left the identity alone:

```sh
codesign -dv --verbose=2 "/Applications/Switch Host.app"   # Identifier, TeamIdentifier
codesign -dr - "/Applications/Switch Host.app"             # designated => identifier … leaf[subject.OU] = <team>
spctl -a -vv "/Applications/Switch Host.app"               # accepted, source=Notarized Developer ID
```

## The grants

For each Mac, server and workstation. System Settings → Privacy & Security, then:

| Grant | App | For | Path |
| --- | --- | --- | --- |
| Full Disk Access | Switch Host | Messages' chat.db, Mail, other apps' data the extensions read | Full Disk Access → + → /Applications/Switch Host.app |
| Accessibility | Switch Host | the hands helper: reading and driving other apps' UI; input in an ask's live view | Accessibility → + → Switch Host |
| Screen Recording | Switch Host | screenshots and screen reading; an ask's live view (the browser extension's screen engine) | Screen & System Audio Recording → + → Switch Host |
| Contacts | Switch Host | the Contacts extension's import from Apple Contacts | Contacts → Switch Host (asked on first use) |
| Calendars | Switch Host | the Calendar extension's two-way sync through EventKit | Calendars → Switch Host → Full Access (asked on first use) |
| Automation: Messages | Switch Host | sending iMessages and SMS | Automation → Switch Host → Messages |
| Automation: Contacts | Switch Host | writing contacts back through Contacts.app | Automation → Switch Host → Contacts |
| Automation: Chrome | Switch Host | driving the signed-in browser | Automation → Switch Host → Google Chrome |
| Automation: System Events | Switch Host | key presses and app control | Automation → Switch Host → System Events |
| Notifications | Switchboard | action items and replies | Notifications → Switchboard → Allow |
| Location | Switch Host | current location, for travel time | Location Services → Switch Host (asked on first use) |

The server only needs what its extensions use: Full Disk Access, Accessibility, Screen Recording and
Automation: Messages for the Messages extension; the workstation the rest.
