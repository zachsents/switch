# Chrome Web Store listing

What the store's developer dashboard asks for, ready to paste. The upload is
`sh scripts/store-zip.sh` (the extension without the manifest's `key`). Images: `screenshot-*.png`
(1280x800), `promo-small-440x280.png`, `promo-marquee-1400x560.png`, and the 128 px icon in
`extension/icons/icon128.png`. `scene.html` draws the images: open it in Chrome at the size, with
`#s1`, `#s2`, `#s3`, `#tile` or `#marquee`, next to `icon.png` (the 128 px icon) and the site's
`geist.woff2`.

## Store listing

- **Name** (from the manifest): Switch
- **Summary** (from the manifest): Lets Switch, the agent on your Mac, see the page you're on and work for you in background tabs.
- **Category**: Productivity, Tools
- **Language**: English
- **Homepage**: https://switch.sents.dev
- **Support**: https://github.com/zachsents/switch/issues

**Description**

```
Switch is a personal agent that runs on your Mac. This extension is its eyes and hands in Chrome.

What it does
- Tells Switch which page is in front, so when you say "this", it knows what you mean.
- Lets Switch do web tasks for you in background tabs, signed in as you are. Its tabs stay in a collapsed "Switch" tab group, so your own tabs and focus stay where they were.
- Closes the agent's idle tabs on its own, and leaves a tab you're looking at alone.

What you need
The Switch app on your Mac. The extension connects only to it, through Chrome's native messaging, and does nothing without it.

Privacy
The extension sends nothing to us or anyone else and makes no network requests of its own. What it reads goes to the Switch app on your Mac. Logins and cards you've saved in Switch are filled into pages without being shown to the agent.
Privacy policy: https://switch.sents.dev/privacy

Switch is open source: https://github.com/zachsents/switch
```

## Privacy practices

**Single purpose**

```
Connects Chrome to the Switch app on the user's own Mac, so the user's Switch agent can see which page is in front and do web tasks for them in background tabs.
```

**Permission justifications**

- **nativeMessaging**: The extension's only connection: it talks to the Switch app installed on the user's Mac, which tells it what to do and receives what it reads. Nothing else is contacted.
- **tabs**: Reads the address and title of the tab in front, so the agent knows which page the user means, and opens, finds, focuses and closes the tabs the agent works in.
- **debugger**: The agent works in its own background tabs through the Chrome DevTools Protocol: it reads the page, clicks, types, scrolls, takes screenshots and waits for loads, without bringing the tab to the front or taking the user's focus. It attaches only to the agent's tabs or a tab the user hands it.
- **tabGroups**: Keeps the agent's tabs in a collapsed "Switch" group, apart from the user's own tabs, and tells agent tabs apart from the user's.
- **storage**: Remembers which tab belongs to which of the agent's tasks, so that survives the service worker restarting.
- **alarms**: Wakes the service worker every minute to reconnect to the Switch app if it was away, and every 30 seconds to let go of idle tabs and close the agent's tabs after half an hour unused.
- **idle**: Tells whether the user has been at the computer in the last 15 minutes, so a tab in front of them is left open as theirs rather than closed as the agent's.
- **Host permissions**: none.

**Remote code**: Yes.

```
The extension loads no code from anywhere and runs none in its own context. At the user's request, their own Switch app on their Mac (connected over native messaging) sends Chrome DevTools Protocol commands for the agent's tabs, which can include JavaScript to evaluate in that page to read it or act on it.
```

**Data usage**: what it handles (all of it goes only to the Switch app on the user's Mac):

- Authentication information (a saved login it fills in when the user asks Switch to sign in)
- Financial and payment information (a saved card it fills in when the user asks)
- Personal communications (pages the agent reads, such as a webmail tab it's asked to work in)
- Web history (the address and title of the tab in front)
- User activity (the agent tabs' network requests and console messages, and whether the user is at the computer)
- Website content (the text, layout and screenshots of pages the agent works in)

Certify all three: not sold or transferred to third parties outside the approved use cases; not used for purposes unrelated to the single purpose; not used to decide creditworthiness or for lending.

**Privacy policy**: https://switch.sents.dev/privacy

## Distribution

- **Payments**: free
- **Visibility**: public
- **Regions**: all
