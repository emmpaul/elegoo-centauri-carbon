# Design

## Context

See proposal.md for why. The current page (`web/index.html`, `style.css`,
`app.ts`) is a card layout with a stop dialog. The design to match lives in
`reference/` next to this file (copied from the Claude Design export, treated
as data):

- `reference/PrinterScreen.dc.html`: the component. Its template holds every
  size, colour, radius, shadow, and copy string; its `<script data-dc-script>`
  holds the per-variant mock snapshots (`preset()`), the dark and light palettes
  (`palette()`), the phone and laptop layout variables (`layout`), and the
  render rules (labels, tones, glyphs, rows, headline, slide, message).
  **This file is the source of truth for pixels.** Where it and `spec.txt`
  differ, the component wins (it is what the reference images were rendered
  from).
- `reference/spec.txt`: the design spec (components, tokens, decisions, field
  mapping, build notes).
- `reference/printer-states.dc.html` and `reference/<id>.png`: the state list
  and a rendering of each state: a1–a8, b1–b2, c1–c5, d1–d2, e1–e4 (light)
  at 360 × 780 (the PNGs are 781 px tall: one extra row from the card edge),
  f1–f2 at 1280 × 660, g1 icon, g2 splash, g3 manifest.

What the server already provides, checked against `src/status-store.ts`,
`src/print-control.ts`, and `src/http-server.ts`:

| The design needs | Provided by | Change |
|---|---|---|
| Printer display name | `snapshot.printerName` (the printer's `Name`, "Centauri Carbon" in every fixture) | none; client falls back to "Centauri Carbon" (D9) |
| Light state | `snapshot.light` (`on`/`off`/`unknown`) | none |
| Command outcome, code, 10 s timeout | `POST /api/command` → `{outcome, code}`; the server times out at 10 s | none |
| Offline "last known" time | `snapshot.updatedAt`, `snapshot.connection` | none |
| Error code | `snapshot.errorCode` (0 = none) | none |
| Fonts, theme script, splash images | `src/dashboard-files.ts` allow-list | new entries; optional files answer 404 when absent (D3) |

So the only server change is in `src/dashboard-files.ts`. `src/control-rules.ts`
already matches the design's enable rules (spec section 3): pause in
preparing/file-checking/printing, resume in paused, stop in those four, light
when its state is known, nothing offline. The design adds "disabled while a
command is in flight", which is client state and stays in the page, as today.
No rule changes.

## Goals / Non-Goals

**Goals:**
- Every state in `reference/` reproduced pixel for pixel by the real page fed
  the same snapshot, in a repeatable harness.
- Presentation logic in a pure, unit-tested module, so states are tested
  without a browser.

**Non-Goals:**
- No change to the HTTP API, snapshot shape, events, or control rules.
- No new configuration setting (printer name comes from the printer, D9).
- No bundler, framework, or runtime dependency.
- The design's simulated print-state transitions after an acknowledgement are
  not emulated: the page shows whatever the next snapshot says.
- Running the visual harness in CI (it needs a browser and the fonts).

## Decisions

### D1. Markup and CSS copy the component; a pure view module computes values
`web/index.html` holds the static structure of `PrinterScreen` (both the token
screen and the dashboard) with `data-field` hooks; `web/style.css` carries the
component's inline styles as classes, with every palette value as a custom
property (`:root` dark, `[data-theme=light]` light, names from the component's
`palette()`: `--bg`, `--sheet`, `--text`…`--text-4`, `--ok`, `--ok-text`,
`--ok-tint`, `--ok-ring`, … `--track`, `--thumb`, `--on-thumb`) and the layout
variables of `layout` (`--cam-h`, `--sh-t`, `--head-t`, …) under phone and
laptop media queries. Per-state values that the component computes in
`renderVals()` (tone, glyph, label, headline, sub-line, tick width, rows,
message, button looks, slide geometry) come from a new pure module
`web/view.ts` (`/view.js`), a function of `(snapshot, page state, now)` that
returns a plain view object; `app.ts` only writes it into the DOM (text,
`hidden`, `data-tone`/`data-glyph`/`data-look` attributes, a few inline
`style` widths/positions). `view.ts` imports only `../src/control-rules.ts`
and types, so `node --test` can test it directly.
*Alternative:* render the whole screen from JS templates. Rejected: more code,
harder to diff against the component's markup.

### D2. Fonts: fetched by the operator, self-hosted, never committed
Satoshi and Cabinet Grotesk are under the ITF Free Font License 2.0. It allows
self-hosting for one's own site, but section 02 forbids distributing the files
"through … repository, … publicly accessible servers", and forbids subsetting
or format conversion. So the woff2 files cannot be in this public repo or in
the published image. New `scripts/fetch-fonts.ts` (`pnpm fonts:fetch`) asks
the Fontshare CSS API for `satoshi@400,500,700` and `cabinet-grotesk@800`,
downloads the official `woff2` file of each weight unchanged, and saves them as
`web/fonts/satoshi-400.woff2`, `satoshi-500.woff2`, `satoshi-700.woff2`,
`cabinet-grotesk-800.woff2`. The operator who runs it obtains their own copy
and self-hosts it, which the licence permits. `web/fonts/` is in `.gitignore`
and `.dockerignore`; a container user mounts a fetched folder at
`/app/web/fonts` (docs/deployment.md). `style.css` declares the four
`@font-face` rules with `font-display: swap` and the design's fallbacks
(`ui-sans-serif, system-ui, sans-serif`; display `'Satoshi', sans-serif`), so
without the files the page renders in system fonts. The page never contacts
Fontshare.
*Alternatives:* commit the woff2 files (the design's intent; forbidden by the
licence for a public repo); link the Fontshare CSS at runtime (breaks the
local-first, works-offline goal and sends every page view to a third party);
substitute open-licence fonts (not pixel perfect).

### D3. Optional static files answer 404
`dashboard-files.ts` gains an `optional` flag: when such a file is missing the
response is `404` instead of an error. The fonts are optional. New required
entries: `/theme.js` (`web/theme.ts`), `/view.js` (`web/view.ts`),
`/stop-slide.js` (`web/stop-slide.ts`), and the splash images. Every browser
file stays in the fixed allow-list (AGENTS.md).

### D4. Theme bootstrap before first paint
`web/theme.ts` is a classic (non-module) script loaded synchronously in
`<head>` as `/theme.js`, before the stylesheet: it reads
`localStorage("theme")` (`"dark"`/`"light"`, wrapped in try/catch) and sets
`data-theme` on `<html>`; with nothing stored it sets nothing, and the CSS
applies light under `@media (prefers-color-scheme: light)` for
`:root:not([data-theme])`. The header toggle stores the opposite of the theme
in effect and updates `<meta name="theme-color">` (`#0f0f0f` dark, `#f3f3f1`
light). A separate file rather than an inline script keeps it typechecked and
avoids needing an inline-script exception if a CSP is added later.

### D5. Phone frame and device chrome
The phone layout reproduces the component's absolute geometry: camera 240 px,
header row 44 px at top 38 px, sheet from 212 px to the bottom of the viewport
(`min-height: calc(100dvh - 212px)`, so a taller screen extends the sheet and
the controls stay at its bottom via `margin-top: auto`; a shorter one scrolls
the page). The token screen keeps the component's 36 px top band. The "21:20"
text in the references is the phone's own status bar, not page content: the
page does not render it. The harness overlays it (13 px/700 at 16 px, 10 px;
`#ececec` over the camera, `var(--text)` on the token screen) so screenshots
compare 1:1.

### D6. Laptop layout from 960 px
At `min-width: 960px` the layout variables switch to the component's laptop
set: header on the page at top 20 px with `--text` ink and a raised theme
button, camera at left/top 24/84 px with right 468 px and 16 px radius, the
sheet as a 420 px panel at right 24 px from 84 px to 24 px above the bottom,
all corners 20 px. Heights follow the viewport (the reference frame is 660 px).
Between 360 and 959 px the phone layout stretches to the width.
*Alternative:* breakpoint at 768 px. Rejected: at 768 the camera column would
be 276 px wide, narrower than on a phone.

### D7. Liveness: SSE open and snapshot online
The page counts as online when the event stream is open and
`snapshot.connection === "online"`; anything else (printer offline,
connecting, service unreachable, no snapshot yet) gets the stale treatment and
the "Offline" header. The build note's "no message for 10 s" rule is not
used: the service pushes a snapshot only when the status changes and its 15 s
keep-alives are SSE comments that `EventSource` never surfaces, so an idle
printer would flap to offline. The printer session already detects silence
(30 s poll) and the snapshot reports it. Before the first snapshot the banner
reads "No contact yet. Controls off." and values show "—".

### D8. Command lifecycle on the existing API
One command at a time. Tap → pending (blue ring on the control, "Sending
<action>…", indeterminate bar, all controls disabled) until `POST
/api/command` answers. `acknowledged` → ok message, cleared after 2600 ms;
`failed` → "<Action> failed · code <n>" (or without " · code" when the code
is null); `timeout` → warn message. The server enforces the 10 s timeout; the
page aborts the request after 15 s as a safety net and shows it as timed out.
HTTP errors (`409 not-allowed`, `503 not-connected`, network) show as failed
with the reason as sub-line; `401` also re-runs the token check. Failed and
timed-out messages stay until Retry (re-sends the same command) or × (clears);
the tapped button reads "Retry" in the bad tone meanwhile. Stop has no Retry in
the message; its track reads "Stop failed · code <n> · again" or "Stop timed
out · again".

### D9. Printer name from the snapshot
The header shows `snapshot.printerName`, falling back to "Centauri Carbon"
when null. The design calls it "a service setting"; the printer already
reports its user-set name, so a config key would duplicate it. This is a
deliberate difference from the design spec.

### D10. Rules copied from the component verbatim
`view.ts` follows `renderVals()` exactly, including details that are easy to
miss: the Elapsed row is left out while a message is showing, when there is an
error, in the unknown state, offline, completed, or idle (this keeps the
controls on the first screen); the Layer row needs a non-zero total and is
left out when completed or idle; targets are "off" at 0, "→ T°" when more than
2° away, else "/ T°"; durations are rounded minutes ("1h 22m", "45m"); "done
HH:MM" is `updatedAt + remaining`; the update time is `HH:MM:SS`; clocks are
24 h local time; the offline banner's minutes are `round((now - updatedAt) /
60000)` ("just now" under 1). Snapshot fields that can be null (the component's
mocks never are) render as "—" and hide their slot when the component would
hide an empty one. `errorCode` counts as an error when it is non-null and not
0 (the snapshot uses 0 for "no error"; the component's mock uses null).

### D11. Camera
The existing `fetch` + `MjpegParser` reader stays (it carries the token as a
header). The `<img>` sits in the camera box with `object-fit: contain` on
`#121212` under the component's vignette and top shade. States: loading/live
(box, no text), unavailable (dotted background, dashed box, "Camera
unavailable" / "Stream didn’t load. Status still live.", Retry, automatic
retry every 10 s, down from 15 s), offline (same box, "Camera offline" /
"Returns with the printer.", no Retry; the stream is closed while offline and
reopened when the printer is back).

### D12. Stop slide
`web/stop-slide.ts` wires a pointer- and keyboard-driven thumb (`role=slider`,
`aria-valuenow` 0–100). Geometry from the component: track 56 px with a 1 px
border, thumb 48 px at `left: 3 + x`, `max = clientWidth - 2 - 6 - 48`; fill
width `x + 54` once past 2 %; label "Keep sliding" beside the thumb, "Release
to stop" left of it from 50 %; release at `x >= max - 2` sends `{action:
"stop", confirm: true}`. → adds `max / 4`, the fourth press sends; ← and Esc
reset. Spring-back uses `left/width 0.25s ease`, disabled under reduced motion.
The pure parts (fraction, label, fill, key handling) live in `view.ts` and are
unit-tested.

### D13. Install assets
`web/icons/icon.svg` is redrawn as the g1 mark (rounded `#222`→`#0f0f0f`
square, one grey and two green bars). `scripts/render-icons.ts` renders it with
Playwright to `icon-192.png`, `icon-512.png`, `icon-maskable-512.png` (full
bleed, bars inside the 80 % safe circle), `apple-touch-icon.png` (180), and
the g2 splash at the portrait sizes of current iPhones (`splash-<w>x<h>.png`,
device pixels, listed with `apple-touch-startup-image` media queries in
`index.html`). The PNGs are committed; the splash's text is an image, which
the font licence permits (a work created with the font). File names stay as
today (`icon-maskable-512.png`, not the design's `icon-maskable.png`). The
manifest takes the design's g3 values: `name`/`short_name` "Printer",
`#0f0f0f` background and theme colour. The service worker's cache becomes
`dashboard-v2` with the new shell files; fonts are cached on first successful
load, never pre-cached (they may be absent).

### D14. Visual harness: `scripts/visual-check.ts`
A script (never under `test/`) that starts its own HTTP server on 127.0.0.1:
dashboard files through `dashboardFiles()`, plus mocked `/api/status`,
`/api/events` (kept open), `/api/command`, and `/camera`, keyed by a
`vstate` cookie per browser context. Each state id maps to the component's
`preset()` snapshot (same values, `NOW = 2026-11-13 21:20:00`), a command
behaviour (`ack`, `failed` code 2, `timeout`, or never answer for pending),
and a camera behaviour (a single MJPEG frame, or `502`). The frame is the
component's mock stream (stripes and "camera · mjpeg stream"), rendered by the
harness itself to JPEG at the box size, so the live box matches the reference.
The browser context uses `timezoneId: "UTC"`, the snapshot times are UTC, and
`page.clock.setFixedTime` freezes `Date.now` at 21:20:00 while timers run.
Interactions use roles: c1 holds the thumb at 74 % with the mouse; c2 drags to
the end; c3–c5 click Pause; d2 seeds the rejected token in local storage;
theme is seeded through `localStorage.theme`. Every id is shot at 360 × 780
(f1, f2 at 1280 × 660) in dark and light, plus g1/g2 from the rendered icon and
splash, into `scratch/visual/` (git-ignored). For ids with a reference in
`docs/design/reference/`, it writes a side-by-side and diff page and prints the
share of differing pixels (per-channel tolerance 8), computed in the browser
canvas, so no image library is needed. It needs the fonts (`pnpm
fonts:fetch`) and exits with a message if they are missing. Chromium comes from
`CHROMIUM_PATH` when set, else Playwright's own lookup.

### D15. `playwright-core` as a pinned devDependency
Added with an exact version (no range), dev only, so the image and runtime are
unchanged; pnpm 10 runs no install script for it (it has none). It drives the
harness and the icon renderer. Dependabot may bump it like the others.
*Alternative:* `npx playwright` ad hoc. Rejected: unpinned, not reproducible.

### D16. Reference files move to `docs/design/`
`reference/` in this change is the planning copy. The first task moves it with
`git mv` to `docs/design/` (no duplicate blobs), so the harness and later
readers find it after the change is archived.

## Risks / Trade-offs

- [Font rasterisation differs between the reference renderer and local
  Chromium] → the harness reports a diff share instead of demanding zero, and
  reviewers judge the side-by-side; layout, colour, and size must match.
- [Without `pnpm fonts:fetch` the page uses system fonts and is not pixel
  perfect] → README and deployment docs say so; the harness refuses to run
  without them.
- [Font licence wording may change] → the script fetches the official files at
  run time and the docs link the licence; nothing licensed is committed.
- [`100dvh` on old browsers] → falls back to `100vh` declared first.
- [Stop by slide is new muscle memory] → keyboard path and on-track label;
  the API still requires `confirm: true`.
- [MODIFIED delta targets a spec that exists only in the unarchived
  `add-local-printer-control`] → archive that change first (Migration Plan).

## Migration Plan

- No data or API migration. The service worker cache name bump drops the old
  shell on next activation.
- OpenSpec: archive `add-local-printer-control` (it creates
  `openspec/specs/printer-dashboard/`) before archiving this change;
  `openspec validate --strict` passes now, but archive refuses MODIFIED
  requirements for a spec that does not exist yet.
- Rollback: revert the change's commits; nothing persists apart from
  `localStorage.theme`, which the old page ignores.
