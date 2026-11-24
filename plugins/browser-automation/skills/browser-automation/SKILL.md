---
name: browser-automation
description: Use the Browser Automation BB plugin for all web browsing. It drives the remote browser on the thread's host, the same signed-in browser the user sees in the side panel. Use for browser navigation, snapshots, clicking, forms, and verification screenshots.
---

Use `bb browser-automation` for all web browsing. It drives the remote browser
on a bb host: headless Chrome that the user sees and controls in the side
panel's Remote browser tab. Do not use `bb browser` to drive the user's desktop
in-app browser; those commands are for the user's own tabs.

Run `bb browser-automation list --json` first and reuse a `ready` session the
thread already has; the user may have opened one from the side panel.
Otherwise open one session, keep its session ID, then inspect, act, and verify
in short scripts.

```sh
bb browser-automation open --json
```

A bare `open` starts the browser on the host of the thread's environment with
the `default` profile. That is the browser the user sees in the side panel, so
you and the user share its cookies, logins, and tabs. The profile keeps them on
that host across sessions, and every session that names it shares one browser.

- `--machine <name-or-id>` runs the browser on another host. It accepts an
  exact host ID or an unambiguous machine name. Exact IDs take precedence over
  names; unknown or ambiguous names fail before opening a session. A thread
  without an environment needs `--machine`.
- `--profile <name>` uses another persistent profile on that host. Profile
  names use 1-40 lowercase letters, digits, and dashes.
- `--temporary` uses a clean, signed-out profile that is deleted on close. Use
  it only when the task needs a fresh browser. It cannot be combined with
  `--profile`.

The CLI uses the current thread, or `--thread <id>` outside a thread. Each
session belongs to that thread. Plugin-owned Chrome launches with
`--no-sandbox`, disabling Chrome's sandbox.

Run scripts:

```sh
bb browser-automation run <session-id> --script 'const p = await browser.getPage("main"); await p.goto("https://example.com"); await p.snapshot()' --json
bb browser-automation run <session-id> --script 'const p = await browser.getPage("main"); await p.click("ref/e6"); await p.snapshot()' --json
bb browser-automation screenshot <session-id> --page main --json
```

Take a fresh snapshot before using refs after navigation or document changes.
Use refs from that session's DevBrowser snapshot. Do not mix agent-browser refs
or invent selectors. Prefer a cheap URL/text/snapshot check after each action;
request a screenshot when visual verification matters. Use
`await p.shot({type:"jpeg",maxEdge:960,quality:70}); undefined` inside scripts to
return a bounded JPEG file. Profile browsers render at device pixel ratio 2, so a
shot's `scale` is below 1 there; divide image coordinates by `scale` before
passing them to `page.mouse`.

`run` and `screenshot` return JSON with `hostId` and `images`, where each image
has `path`, `mimeType`, `width`, and `height`. The path is in the browser session's
temporary directory on that host. Use your image-reading tool on the path when
you are on the same machine. If the browser host differs, fetch the image to
local temporary storage first (substitute the returned path and host ID):

```sh
bb file read '<image-path>' --host '<host-id>' --json | node -e '
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const file = JSON.parse(fs.readFileSync(0, "utf8"));
if (file.contentEncoding !== "base64") throw new Error("Expected binary image");
const destination = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "browser-image-")), "capture.jpg");
fs.writeFileSync(destination, Buffer.from(file.content, "base64"), {mode: 0o600});
console.log(destination);
'
```

Read the printed local path with your image-reading tool. Do not print base64
image bytes into the conversation. Read or copy captures before closing the
session: cleanup removes its temporary directory. Remove local copies when
finished.

`open` returns a `previewDirective`, for example
`::browser-preview{session="<session-id>"}`. Copy it into your next message
exactly once as a standalone line, before you continue working. Do not wrap it
in backticks or a code fence, and do not invent or edit the session ID. BB
renders it as a live view of that browser in the chat, which the user can
expand, so they can watch while you work. `bb browser-automation preview <session-id> --json` reports the live
frame's `url`, `title`, size, `sequence`, open `tabs`, and `activeTabId` without
image bytes; it is not a substitute for `screenshot` when you need to see the
page. The user can click, type, scroll, navigate, and switch tabs in the
full-size viewer while you work. Re-snapshot before acting if the page may
have changed under you.

`pages` lists persistent pages. Runs serialize within a session. Scripts are
trusted JavaScript with Puppeteer-style DevBrowser APIs, not a sandbox.
`--script-file` requires `--script-host <host-id>` naming the source host explicitly. Browser file
operations and `localhost` refer to the browser host. Transfer files explicitly.

Stop cancels running and queued work. Cancellation
and timeout stop the session too; open a new session to resume. A run whose
output passes 512 KB fails with exit code 1 but keeps the session open; return
or print less and run again. Closing a temporary session disposes its Chrome.
Closing a profile session closes only the named pages it opened; the browser
keeps running for other sessions on that profile, and the last one to close
saves its tabs and cookies.
Close sessions after use. When `close` or `stop` fails, the session still
accepts no more commands, but its browser may still be running; run `close`
again to retry cleanup. `run`, `pages`, and `screenshot` renew expiry at their start and completion to
30 minutes later, capped at eight hours from creation. Active scripts are not idle;
the hard deadline still stops running work. `list` and thumbnail previews do not
renew expiry; the full-size viewer and the user's input in it do. Timeouts default to 30 seconds, maximum 120 seconds: pass either
`--timeout-ms <1000-120000>` or `--timeout <duration>`, where a duration carries
a unit (`90s`, `2m`, `1500ms`) and a bare number is read as seconds (1-120) or
milliseconds (1000-120000).

A run may return at most 4 screenshots, JPEG only, 500 KB combined; a larger or
differently encoded capture fails the run. `bb browser-automation --help` and
`bb browser-automation <command> --help` print every flag with these limits.
Unknown commands and flags fail with a suggestion, and with `--json` a failure
prints `{"ok":false,"error":{"code":…,"message":…,"hint":…}}` on stdout (code
`session_unavailable` when the session stopped or expired, `screenshot_limit`
for capture limits) while the same message stays on stderr.

An unavailable host or a failed runtime install is an actionable setup error,
not permission to use another browser. The first open on a host
installs the pinned `dev-browser` npm release into plugin-owned host storage
there and verifies its provenance and digest; it needs npm, network access, and
Chrome on that host, and can take a minute. Later opens reuse the verified
install offline. The exact pin and Chrome setup are documented in the plugin
README. Cloud browsers and arbitrary CDP endpoints are unsupported.
