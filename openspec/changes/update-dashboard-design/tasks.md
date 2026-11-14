# Tasks

Pixel values, copy, and per-state rules come from
`docs/design/reference/PrinterScreen.dc.html` (moved there in 1.1; until then
`openspec/changes/update-dashboard-design/reference/`). "Harness check <ids>"
means: run `node scripts/visual-check.ts <ids>` (group 2) and confirm in its
side-by-side page that each listed id matches its reference in layout, size,
colour, and copy, with the reported diff share no higher than font
anti-aliasing explains.

## 1. Design references and fonts

- [x] 1.1 Move `openspec/changes/update-dashboard-design/reference/` to `docs/design/reference/` with `git mv` (component, states page, `spec.txt`, a1–g3 PNGs) and add a two-line `docs/design/README.md` naming the source artifact and that the files are data; verify `git status` shows renames only
- [x] 1.2 Add an `optional` flag to `src/dashboard-files.ts` (missing optional file → 404, no throw) and the four font paths `/fonts/satoshi-{400,500,700}.woff2` and `/fonts/cabinet-grotesk-800.woff2` (`font/woff2`, optional); let `dashboardFiles()` take an optional web directory so tests can point it at a temp copy; extend `test/http-server.test.ts` so, without the token, a missing font answers 404 and a font present in the temp directory answers 200 `font/woff2`; verify `pnpm typecheck && pnpm test`
- [x] 1.3 Add `scripts/fetch-fonts.ts` and the `fonts:fetch` package script (D2): read the Fontshare CSS API for satoshi@400,500,700 and cabinet-grotesk@800, download each weight's official woff2 unchanged into `web/fonts/`, print what it saved and a link to the ITF Free Font License; add `web/fonts/` to `.gitignore` and `.dockerignore`; verify `pnpm fonts:fetch` writes the four files, `git status` stays clean, and `curl -I` on `/fonts/satoshi-500.woff2` from `pnpm start:fake` answers 200
- [x] 1.4 Document the fonts: README (dashboard section: run `pnpm fonts:fetch` for the designed typefaces, licence note, system-font fallback) and `docs/deployment.md` (mount a fetched `web/fonts` at `/app/web/fonts:ro`); verify the documented commands run as written

## 2. Visual verification harness

- [x] 2.1 Add `playwright-core` as an exact-version devDependency (D15) and record the version in `pnpm-lock.yaml`; verify `pnpm install --frozen-lockfile && pnpm typecheck` pass and `node -e "import('playwright-core')"` loads
- [x] 2.2 Add `scripts/visual-check.ts` (D14): its own 127.0.0.1 server with dashboard files and per-state mocked `/api/status`, `/api/events` (held open), `/api/command`, `/camera`, keyed by a `vstate` cookie; state table a1–a8, b1–b2, c1–c5, d1–d2, e1–e4, f1–f2 built from the component's `preset()` values and NOW 21:20:00 UTC; frozen clock, `timezoneId: "UTC"`; generated mock camera frame; role-based interactions for c1–c5 and d2; theme seeding; device-clock overlay (D5); `CHROMIUM_PATH` support; refuses to run without fonts; usage comment at the top listing ids, output folder, and env; verify `pnpm typecheck` passes and `node scripts/visual-check.ts a1 b2 d1` writes screenshots of the current page to `scratch/visual/` (an unreachable interaction is reported per id, not a crash)
- [x] 2.3 Add the comparison output to the harness: for ids with a reference, a side-by-side page with a diff overlay and the share of differing pixels (canvas, per-channel tolerance 8), printed per id; both themes shot for every id, g1/g2 compared once their PNGs exist; add the harness to the Commands section of `AGENTS.md`; verify a run prints a diff share for a1 and writes `scratch/visual/index.html`

## 3. View model

- [ ] 3.1 Add `web/view.ts` (D1, D10) for the status parts: printer name fallback (D9), online/stale decision (D7), state label, tone, glyph, file slot, update clock, headline (time left, %, sub-line per state), tick width and colour, error alert, unknown-state note, offline banner text, and rows with target column rules; serve it as `/view.js` in `src/dashboard-files.ts` (with a served-and-stripped assertion in `test/http-server.test.ts`); add `test/dashboard-view.test.ts` covering the a1–a8 and b1 snapshots with the exact strings from the references, null fields, and errorCode 0; verify `pnpm typecheck && pnpm test`
- [ ] 3.2 Extend `web/view.ts` with controls, message, and slide: per-control look (enabled fill, dashed disabled, pending ring, failed Retry) using `isAllowed` from `src/control-rules.ts` plus the in-flight rule, Light label/dot/pressed, message slot per lifecycle (D8) and the drag consequence, slide geometry, labels, disabled reasons, and the keyboard step function (D12); add tests for c1–c5, every disabled reason, and that each control's enabled state equals `isAllowed` for every print state; verify `pnpm typecheck && pnpm test`

## 4. Page frame and status sheet

- [ ] 4.1 Tokens and theme: rewrite the base of `web/style.css` with the dark and light custom properties from the component's `palette()`, the phone layout variables, the `@font-face` rules (D2), font stacks, and reduced-motion rules; add `web/theme.ts` served as `/theme.js` (D4) and loaded first in `<head>`; verify `pnpm typecheck && pnpm test`, and in `pnpm start:fake` the page opens in light with `localStorage.theme = "light"` and no dark flash
- [ ] 4.2 Header and camera: replace the top bar and camera card in `web/index.html` with the component's camera box and header (name, Online/Offline mark, 44 × 44 theme toggle that stores the choice and updates `theme-color`), wire them in `web/app.ts` from `view.ts`, and implement the camera states and 10 s retry (D11); update the Dashboard section of `docs/api.md` (camera retry interval); verify `pnpm typecheck && pnpm test`, `FAKE_CAMERA=down pnpm start:fake` shows "Camera unavailable" with Retry, and harness check a1 and b2 (header and camera area)
- [ ] 4.3 Status sheet: replace the print and temperature cards and the footer with the sheet (offline banner, status line, headline, ticks with `role=progressbar`, error alert, unknown note, rows) rendered from `view.ts`, with the stale treatment (D7) and the document title; verify `pnpm typecheck && pnpm test`, `SIGUSR2` on `pnpm start:fake` shows the offline banner, and harness check a1–a8, b1 (above the controls)

## 5. Controls

- [ ] 5.1 Replace the controls card with the message slot and the Light, Pause, Resume buttons (component markup and looks), the command lifecycle of D8 (pending ring and indeterminate bar, 2.6 s ack clear, failed/timeout with Retry and ×, HTTP errors, 15 s safety abort), keeping the old stop button and dialog working until 5.2; verify `pnpm typecheck && pnpm test`, `FAKE_REPLIES=129=silent,131=2 pnpm start:fake` shows the timeout and "failed · code 2" messages, and harness check c3, c4, c5
- [ ] 5.2 Replace the stop button and dialog with the stop slide in `web/stop-slide.ts` served as `/stop-slide.js` (D12): pointer drag with capture, spring-back, send at the end with `confirm: true`, keyboard steps, disabled reasons, "Stopping…" pending track, failed/timed-out labels; add the file to the service worker shell; update `docs/api.md` (stop is confirmed by the slide); verify `pnpm typecheck && pnpm test`, in `pnpm start:fake` an early release sends nothing and a full drag or four → presses stops the print, and harness check a1, c1, c2, b1 (controls area)

## 6. Token screen and laptop layout

- [ ] 6.1 Replace the token form with the component's token screen (app mark, title and body per first run or rejected, labelled field with Show/Hide, red ring and "Rejected (401)." alert keeping the rejected value, Connect, "Stored on this device only."), editing the field clears the error; verify `pnpm typecheck && pnpm test`, `ACCESS_TOKEN=t pnpm start:fake` with a wrong stored token shows the rejected screen and the right token connects, and harness check d1, d2, e4
- [ ] 6.2 Add the laptop layout at `min-width: 960px` (D6): header on the page, camera in the free width, 420 px panel, laptop radii and insets, theme button look; verify `pnpm typecheck && pnpm test`, no horizontal scroll from 360 to 1440 px in the harness, and harness check f1, f2

## 7. Install assets

- [ ] 7.1 Redraw `web/icons/icon.svg` as the g1 mark and add `scripts/render-icons.ts` (D13) that renders `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, and `apple-touch-icon.png` from it, then commit the PNGs; verify the existing manifest test passes, and harness check g1 against the rendered icons
- [ ] 7.2 Extend `scripts/render-icons.ts` to render the g2 splash at the current iPhone portrait sizes into `web/icons/splash-<w>x<h>.png`, add them to `src/dashboard-files.ts` and as `apple-touch-startup-image` links with media queries in `web/index.html`; extend `test/http-server.test.ts` so every `apple-touch-startup-image` link in the page is served as `image/png`; verify `pnpm typecheck && pnpm test` and harness check g2
- [ ] 7.3 Update `web/manifest.webmanifest` to the g3 values (D13), the `theme-color` meta, and `web/sw.ts` (cache `dashboard-v2`, new shell files, fonts cached on first load only); extend the manifest test for name, colours, and display; verify `pnpm typecheck && pnpm test` and that the manifest matches g3 field for field

## 8. Integration check

- [ ] 8.1 Run the full harness (every id, dark and light, 360 and 1280) with fonts installed, fix any remaining difference in the task's own files, and confirm every referenced id matches; also check with the keyboard that the theme toggle, buttons, Retry, ×, and the stop slide are reachable and work in tab order, and that 360 px has no horizontal scroll in any state; verify `pnpm typecheck && pnpm test` pass and the harness index shows every id

## Workflow follow-up

- Three independent reviewers compare `scratch/visual/` with `docs/design/reference/` and must agree the implementation is pixel perfect before the run ends.
- Archive `add-local-printer-control` before archiving this change (design.md, Migration Plan).
