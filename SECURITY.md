# Security

Report a vulnerability privately, through
[a security advisory](https://github.com/zachsents/switch/security/advisories/new), not in an issue.

Switch runs agents with access to your Mac, your accounts and your messages. In scope: anything
that lets someone else's words (an email, a web page, a message) make it act, read `~/.switch`, or
put in an update. Each release's `update.json` is signed (Ed25519), and the app checks that
signature, the download's SHA-256 and its Apple team before installing it.
