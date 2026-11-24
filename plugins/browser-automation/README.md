# Browser Automation for BB

Thread-owned browser scripts in the remote browser: headless Chrome on an
enrolled bb host that the user also sees and controls in the side panel's
Remote browser tab. Agents and the user share one signed-in browser.

Browser Automation is optional and disabled by default. Enable it in plugin
settings when you want to use it.

The plugin was scaffolded with `bb plugin new browser-automation`. It has server, host,
app, CLI, RPC, and a bundled skill. Agents use the CLI through the skill. Screenshot
commands return temporary JPEG file paths and the browser host ID. Sessions show
a live preview inline in the chat that expands into a lightbox; see
[Live preview](#live-preview). Screenshot cards and a screenshot sidebar viewer are not included. Cloud provisioning and arbitrary CDP endpoints are excluded.

## Runtime installation and provenance

The DevBrowser runtime is installed automatically on the **selected browser
host** the first time a session is opened there. Nothing is installed on the
server or on the invoking agent's machine, and the user's global npm
installation is never touched. `runtime-pin.ts` pins one exact npm release:

| Field        | Value                                                               |
| ------------ | ------------------------------------------------------------------- |
| package      | `dev-browser@1.0.0-rc.4` from `registry.npmjs.org`                  |
| repository   | [SawyerHood/dev-browser](https://github.com/SawyerHood/dev-browser) |
| tag / commit | `v1.0.0-rc.4` at `e5d746f1fc17a3301d6e7f865f89c034f15f69fb`         |
| linux-x64    | `fa6cec3f84463e171bd7b307e2e1f0243df59c70c38f96d790dc41b160db921a`  |
| linux-arm64  | `578db7f1e502cf6b9e43ac09e6adc5720f5397fa3e6d6b7b9ba8377708fe040e`  |
| darwin-x64   | `7cfad83f7f9e16dc5acbc94553430bcd1be24adc4304c0f534805969bfa6d2ba`  |
| darwin-arm64 | `f0a7e7d10ab8be0fee1ee8ac2ca33d3efc46b493e5e998b29ea75c79479a2e8d`  |

The digests are the SHA-256 values published in that release's `SHA256SUMS`.
The pin never follows the `next` or `latest` dist-tags and never falls back to
another version. Windows has no upstream artifact and is refused.

On the browser host the installer (`installer.ts`, run inside the plugin host
worker) performs these steps under
`<plugin host dataDir>/runtime/npm/`, a directory owned by the plugin:

1. Locate `npm` on the host worker's `PATH`; a missing npm is a clear error
   naming the host requirement. npm 9.5 or newer is required for attestation
   checks.
2. `npm install --ignore-scripts` of the exact version from the pinned
   registry (passed explicitly, so a host `.npmrc` mirror cannot substitute
   it) into a private staging directory with a plugin-owned npm cache. The
   package's own postinstall is never run, and the resolved tarball URL must
   come from the pinned registry.
3. `npm audit signatures --json` must exit zero with no invalid or missing
   signatures. The SLSA provenance attestation is then fetched from the
   registry: its subject digest must equal the installed tarball integrity and
   its workflow must name the pinned repository at tag `v<version>`.
4. Download `dev-browser-<platform>` and `SHA256SUMS` from the GitHub release
   for that tag into the package's `bin/dev-browser-bin`, the location the
   package's own shim expects. The stream digest must equal the pinned
   digest, and `SHA256SUMS` must agree, before the file is used.
5. Run `dev-browser-bin --version` and require the pinned version, write
   `verified.json`, and atomically rename the staging directory to
   `runtime/npm/dev-browser@<version>/`.

Warm starts read `verified.json`, re-hash the binary, and use it without npm or
network access; a tampered or missing binary triggers a fresh install. A lock
file, created atomically with the installer's PID, serializes concurrent
installs across worker processes; in-process callers share one job. Locks
whose owner process is gone are reclaimed only after re-checking their
identity, and staging directories are scoped per package version. An interrupted or failed install removes its staging directory
and leaves no partial runtime; the next open retries. When no session is
waiting on an install for 15 seconds, the install is cancelled.

Because a first install can exceed the 30-second host RPC deadline, the server
polls the host's `prepare` RPC, which long-polls the shared install job and
reports progress, before calling `open`.

### No fallback

A platform without a recorded digest fails with an explicit error; the plugin
never falls back to another version, a `PATH` binary, or the older pre-release
integration build. The `smoke` task takes an explicitly provided binary and
labels it `developer-artifact`; that source exists only for fixtures and is
never chosen automatically. The upstream MIT license is preserved in
`DEVBROWSER-LICENSE`.

### Bumping the pin

1. Wait for the upstream tag workflow to publish both the npm version and the
   GitHub release; merging alone publishes nothing.
2. Fetch `https://github.com/SawyerHood/dev-browser/releases/download/v<version>/SHA256SUMS`
   and copy the four digests into `runtimeRelease.artifacts`.
3. Confirm `npm view dev-browser@<version> gitHead` matches the tag commit.
4. Run `pnpm exec turbo run smoke:install --filter=bb-plugin-browser-automation` on a
   Linux and a macOS host.

Headless sessions need Chrome/Chromium on that host. The plugin checks
`<plugin host dataDir>/runtime/chrome`, the standard macOS Chrome path, then
`google-chrome`, `google-chrome-stable`, `chromium`, and `chromium-browser` on
PATH. The `runtime/chrome` entry can be a symlink to an installed executable.
Plugin-owned Chrome always launches with `--no-sandbox`, disabling
Chrome's sandbox so it can run on hosts that restrict unprivileged user namespaces.
It also launches with `--password-store=basic` and `--use-mock-keychain`; without
them, Chrome waits about 25 seconds for a desktop keyring on the first request
of a headless session. It reports the host Chrome's version in a regular,
non-headless user agent.

## CLI and agent workflow

A bare `open` starts the remote browser on the host of the thread's
environment with the `default` profile, the same browser the side panel shows.
`--machine` picks another host, `--profile` another persistent profile, and
`--temporary` a throwaway profile. `--profile` and `--temporary` cannot be
combined. A thread without an environment needs `--machine`.
The agent instructions tell agents to browse only with `bb browser-automation`.
They also tell agents not to drive the user's desktop in-app browser with
`bb browser`; those commands are for the user's own tabs.

```sh
bb browser-automation open [--machine <name-or-id>] [--profile <name> | --temporary] --json
bb browser-automation list --json
bb browser-automation run <session-id> --script 'const p = await browser.getPage("main"); await p.goto("https://example.com"); await p.snapshot()' --json
bb browser-automation run <session-id> --script-file ./check.js --script-host <invoking-host-id> --timeout-ms 30000 --json
bb browser-automation pages <session-id> --json
bb browser-automation screenshot <session-id> --page main --json
bb browser-automation preview <session-id> [--after <sequence>] --json
bb browser-automation stop <session-id> --json
bb browser-automation close <session-id> --json
```

Outside a thread, supply `--thread <thread-id>`. Calls from an existing thread
cannot override its ownership. `--script-file` requires `--script-host <host-id>` naming the source host
explicitly and is read through `bb.sdk.files`, then transferred as script text to the
browser host. Relative paths use the invoking CLI working directory. Browser
file reads/writes still occur on the browser's host; scripts are not run in the
workspace directory.

With `--temporary`, a session owns a Chrome process and a separate, empty
profile in a temporary directory that `close` deletes. Otherwise it uses the
`default` profile, or `--profile <name>` (1-40 lowercase letters, digits, and
dashes, starting with a letter or digit). A profile lives at `<plugin host dataDir>/profiles/<name>` on that host,
and every open session naming the profile shares one Chrome. Closing such a
session closes only the named pages it opened. When the last session on a
profile closes, the host saves up to 20 open http(s) tab URLs to
`bb-tabs.json` in the profile, closes Chrome with `Browser.close` so cookies
reach disk, and stops it after five seconds if it has not exited. The next
launch reopens the saved tabs. A launch waits for the previous shutdown of the
same profile to finish. Profile browsers render at device scale factor 2, so
the side panel stays sharp on high-density screens; temporary-profile browsers
render at 1. Full-size previews are JPEG frames up to 2560 pixels on a side,
and the host lowers their quality step by step when a frame would exceed the
preview frame limit. The app's remote browser side panel opens sessions
with the `default` profile, and so does a bare `open`, so the agent and the
user share one browser. Each session owns a
fresh `DEV_BROWSER_HOME` and socket under the worker's temporary directory.
Pages and cookies persist between runs in that session. `stop`, timeout, or
cancellation terminates that session; open another session to resume.
`close` disposes its processes and session directory. Sessions close after 30 minutes without `run`, `pages`, or `screenshot` activity.
Each operation renews expiry at its start and completion, up to eight hours from
creation; active scripts do not count as idle. The hard deadline also stops running
work. `list` and thumbnail previews do not renew expiry; full-size
previews and viewer input do. Archiving, deleting, or failing a thread
closes its sessions; normal idle turns preserve them. Externally invoked CLI
runs remain subject to the same per-run timeout and absolute session expiry. Run timeouts default to 30 seconds and are
bounded to 1–120 seconds. Runs are serialized per session.

DevBrowser scripts are trusted code, not a security sandbox. Script output is
bounded to 512 KB before parsing and 160,000 text characters after parsing.
A run whose output passes 512 KB is stopped and fails with exit code 1; the
session stays open.
Up to four JPEGs fit within a combined 500 KB budget. Image file paths
must resolve inside that session's capture directory; oversized files and
escaping symlinks fail. CLI `run` and `screenshot` JSON returns `hostId` plus
`images: [{path, mimeType, width, height}]`, without inline image bytes. Paths
are in the browser session's temporary directory on the selected host. Agents
read them directly on that machine, or use `bb file read <path> --host <host-id>
--json` to fetch a remote image and decode its base64 content to a local temporary
JPEG. The bundled skill includes a copy-pasteable command. Read or copy captures
before closing the session; cleanup removes them. Endpoints and connection
credentials are removed from structured script text and never included in
session records or CLI session results.

The CLI uses the same validated operation handlers as RPC. The
RPC contract in `contracts.ts` exposes `open`, `list`, `run`, `pages`,
`screenshot`, `preview`, `input`, `openForThread`, `stop`, and `close`.
RPC inputs include `threadId`; session operations also include `sessionId`.
`open` takes `{threadId, hostId?, profile}`. A missing `hostId` means the
host of the thread's environment. `profile` defaults to `"default"`, and
`null` means a temporary profile. Stored session records from the removed
desktop backend are deleted when the plugin starts.
`openForThread` serves the side panel: it returns the thread's newest ready
session, or opens one with the `default` profile on the host of the
thread's environment. Concurrent calls for one thread share a single open. A
thread without an environment fails with a pointer to `open --machine`.
Agents discover the commands through the skill and CLI help.

The host supervises Chrome and the DevBrowser daemon as separate children. Each
child owns a process group. Closing the worker pipe also stops those groups, so
a worker crash does not leave browsers running. Stop sends TERM then KILL after
1.5 seconds. The plugin does not discover or kill processes from PID files.
`stop` and `close` retire the session before cleanup starts, so it accepts no
more commands and an `open` still starting is aborted. They succeed only once
the host has released the browser processes and session directory. Otherwise they fail with the reason,
including a host that does not answer within 10 seconds. Concurrent closes
share one outcome, and closing again retries cleanup. A host worker repeats a
session's close outcome until that worker exits, and refuses to reopen a
session it already closed.
Server metadata persists ownership and cleanup needs; restart reconciles active
sessions and retries unfinished cleanup. Unreachable cleanup remains recorded
for reconciliation on a later plugin load.

## Live preview

Opening a session returns a `previewDirective` in the CLI
result, `::browser-preview{session="<session-id>"}`. The plugin's agent
instructions tell the agent to paste it once, as a standalone line, in its next
message. BB renders that line inline in the chat as a live thumbnail of the
browser with the page title, location, and a Live, Ended, or Unavailable state.
The card collapses, and its expand button opens the same live view in a
lightbox sized to the window; on compact screens the lightbox is the shared
responsive drawer. The lightbox is mounted once per window as an app overlay,
not inside the card, so it stays open and live when the timeline paginates the
card away.

Frames come from a second CDP connection that the host worker opens to the
session's own Chrome (`preview.ts`). It runs `Page.startScreencast` as
JPEG at about four frames per second, at most 800 pixels on the long edge for
thumbnails. While a lightbox or side panel requests `size: "full"` it recasts
the same page at about ten frames per second, up to 1280 pixels on the long edge, and
returns to thumbnails ten seconds after the last full-size request. It casts
only while something is watching: the connection closes after 15 seconds
without a request and reopens on demand. It previews the page that navigated
most recently, preferring any page over `about:blank`, so it follows the named
page a script is driving, until the viewer picks a tab; then it stays on that
tab until the tab closes. Every frame carries the browser's open `tabs` (up to
20, each `{id,url,title}`) and the `activeTabId` it shows. Previews never enter
the per-session run queue, so they keep updating while a script runs and never
delay one.

### Viewer input

The `input` RPC takes a batch of 1-64 viewer actions for a ready session
the thread owns and applies them to the previewed tab over the same CDP
connection: mouse and wheel events (`Input.dispatchMouseEvent`), keys
(`Input.dispatchKeyEvent`), text (`Input.insertText`), navigation, back and
forward through the tab's history, reload, resizing the window
(`Browser.setWindowBounds`, 320-2560 by 240-2560), and selecting, opening, or
closing tabs. A new tab becomes the previewed tab. Input waits up to ten
seconds for the cast to attach and fails for sessions that are not ready and
sessions of other threads. Input does not enter the run
queue, so the user and a running script can act on the same page at once.

The app long-polls the `preview` RPC with the last sequence it rendered and the
`size` it needs, `thumbnail` by default; the
server forwards to the host's `preview` RPC, which answers as soon as a newer
frame exists or after five seconds with `frame: null`. Full-size requests and
input renew the session's expiry; thumbnail requests do not. An inline card polls
only while the window is visible and it is expanded and scrolled into view, so
cards left behind in the chat history cost nothing. The lightbox opens from the
card's current frame and then runs its own poller; the card pauses its poller
while its session's lightbox is open. When the session stops, closes, or expires, the card keeps its last
frame dimmed for as long as it stays mounted; a card first viewed after that
shows only its Ended header. A card whose session it can never read, such as a
directive copied into a forked thread, gives up after five failed requests.

`bb browser-automation preview <session-id> --json` reports the same live frame
as `{session, frame}` where `frame` has `sequence`, `mimeType`, `width`,
`height`, `url`, `title`, `tabs`, `activeTabId`, and `bytes`, or is `null` when nothing newer than
`--after` arrived. It omits the image bytes; use `screenshot` for a file.

## Validation

From the BB checkout, use Turbo:

```sh
pnpm exec turbo run test typecheck build --filter=bb-plugin-browser-automation
DEV_BROWSER_SMOKE_BINARY=/absolute/path/to/verified/dev-browser \
DEV_BROWSER_SMOKE_CHROME=/absolute/path/to/chrome \
pnpm exec turbo run smoke --filter=bb-plugin-browser-automation
DEV_BROWSER_SMOKE_CHROME=/absolute/path/to/chrome \
pnpm exec turbo run smoke:install --filter=bb-plugin-browser-automation
```

`installer.test.ts` drives the installer against a fake `npm` and a local
release server: exact-version install, provenance rejection, digest and
`SHA256SUMS` mismatches, warm reuse without npm or network, tampered-binary
reinstall, concurrent callers, stale locks, and cancellation cleanup.

`smoke:install` performs a real cold install of the pinned release from
npm and GitHub into a disposable data directory, then a warm resolve with no
npm on `PATH`, then drives real headless Chrome through the installed binary,
including a cross-origin iframe snapshot and a JPEG screenshot. It prints the
binary path, its SHA-256, and timings.

`smoke` takes an explicit binary and creates disposable directories and runs
real Chrome, without starting a BB core or using an existing browser profile.
It verifies named pages, navigation, clicking, JPEG bytes, a live preview that
follows a second named page while its script runs and switches to full-size
frames on request, serialization,
independent session cancellation, a synchronous infinite-loop timeout,
reopening, and closing a runtime session (further runs are rejected).
Both smokes link directly to Chrome and exercise the production launch flags
without a wrapper.

Build with a current BB CLI: an older installed CLI can successfully bundle the
sources while stamping old SDK metadata. Inspect `dist/*.meta.json` before any
future installation or distribution. Generated bundles and declarations are
ignored. No plugin installation or live core is needed for these checks.
