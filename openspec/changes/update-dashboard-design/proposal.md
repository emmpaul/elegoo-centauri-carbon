# Proposal

## Why

The dashboard in `web/` is a plain form-style page: cards, a confirm dialog for
stop, a `<progress>` bar, and a blue theme. A finished design now exists (Claude
Design project "Printing screen directions", direction 2a, artifact
`0453a4b0-f4f0-4f85-adf4-90c15d2bea9e`) that puts the camera first, names the
state in words and shape, makes stop a deliberate slide, and shows staleness
and command outcomes in place. The page should match that design pixel for
pixel at 360 px and 1280 px, in dark and light, for every state the design
lists, so a notification tap answers "is the print fine?" at a glance.

## What Changes

- Rebuild `web/index.html`, `web/style.css`, and `web/app.ts` to the design's
  `PrinterScreen` component: camera box with header over it (phone) or beside
  it (laptop, 420 px panel), status line with state glyph, headline time left
  and percent, layer ticks (`role=progressbar`), alert blocks, reading rows,
  message slot, Light / Pause / Resume buttons, and a slide-to-stop track.
- **BREAKING (UI only)**: stop is confirmed by dragging the slide to its end (or
  four → key presses) instead of a confirm dialog. The API's `confirm: true`
  rule is unchanged.
- Pause and Resume are both always visible; the unavailable one is dashed.
  The Light button names the light's current state ("Light on" / "Light off").
- Offline and stale data get the design's six-way treatment (banner, dashed
  glyph, "last known" sub-line, secondary ink with dashed dividers, grey ticks,
  dashed controls) and the camera shows "Camera offline".
- Command outcomes appear in one message slot above the controls: pending
  (blue ring, indeterminate bar), acknowledged (clears after 2.6 s), failed
  with code, or timed out, the last two with Retry and dismiss.
- Dark theme by default, light theme by `prefers-color-scheme` or a 44 × 44
  toggle remembered in local storage, applied before first paint.
- Token screen redesigned; a rejected token stays in the field for editing.
- Typography: Satoshi and Cabinet Grotesk, self-hosted from `web/fonts/` when
  the operator has fetched them with a new `pnpm fonts:fetch` script; the files
  are not committed (their licence forbids redistribution) and the page falls
  back to system fonts without them.
- New app icon, iOS splash images, and manifest colours (`#0f0f0f`).
- `src/dashboard-files.ts` serves the new files (theme bootstrap script, optional
  fonts that answer 404 when absent, splash images).
- A visual-verification script under `scripts/` that serves the dashboard with
  mocked API responses and a frozen 21:20 clock and screenshots every design
  state id for 1:1 comparison with the design references; `playwright-core`
  becomes a pinned devDependency.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `printer-dashboard`: the live status view, camera view, control buttons, and
  phone/installable requirements change to the design's behaviour; new
  requirements add the stop slide, the command message slot, stale data
  treatment, theming, laptop layout, the token screen, typography, and
  accessibility. (Its base spec is still a delta of the unarchived change
  `add-local-printer-control`; see design.md, Migration Plan.)

## Impact

- Code: `web/index.html`, `web/style.css`, `web/app.ts`, new `web/theme.ts`, `web/view.ts`, `web/stop-slide.ts`,
  `web/manifest.webmanifest`, `web/sw.ts`, `web/icons/*`, `src/dashboard-files.ts`,
  new `scripts/fetch-fonts.ts`, `scripts/render-icons.ts`,
  `scripts/visual-check.ts`.
- No change to the HTTP API, the snapshot, `control-rules.ts`, or the printer
  protocol. `docs/api.md` (Dashboard section) and `README.md` change.
- Dependencies: `playwright-core` (devDependency, pinned). No runtime
  dependency is added.
- Container: `.dockerignore` keeps `web/fonts/` out of the image; operators who
  want the fonts mount them (docs/deployment.md).
