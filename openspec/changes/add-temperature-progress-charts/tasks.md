# Tasks

"D<n>" points to `design.md`. Every test named here runs under `pnpm test`. Each task
also keeps `pnpm typecheck` passing. Synthetic test data follows the fixture redaction
rules (`test-print-<n>.gcode`, `192.0.2.10`, `00:00:00:00:00:00`).

## 1. Snapshot fields

- [ ] 1.1 Add `speed`, `fans: { part, aux, box }`, and `z` to `StatusSnapshot` in `src/status-store.ts`, filled from `PrintSpeedPct`, `CurrentFanSpeed`, and the third part of `CurrenCoord` (D9). Verify with new cases in `test/status-store.test.ts`:
  - the scenario push gives speed 100, fans 100/40/30, and Z 12.4;
  - a missing or `"1,2"` `CurrenCoord` gives Z null, with the other fields still updated;
  - `emptySnapshot()` holds nulls.
- [ ] 1.2 Update the snapshot example and field table in `docs/api.md`, and the "Normalized live status" note in `docs/sdcp-protocol.md` if it lists the fields the service reads. Verify that `curl` on `/api/status` against `pnpm start:fake` shows the new fields as documented.

## 2. Archive: Readings storage

- [ ] 2.1 Add schema step 2 (the `readings` table and partial index, D3) to `MIGRATIONS` in `src/history-store.ts`. Verify in `test/history-store.test.ts`:
  - a new file reports `user_version` 2;
  - a v1 file holding jobs and a thumbnail upgrades to 2 with the same `list()` and `thumbnail()` answers;
  - a file set to version 3 is still refused, naming both versions.
- [ ] 2.2 Add `addReading`, `readingsSince(since, now)`, and `trace(taskId)` to `HistoryStore` (D3, D5). States go out named, and `trace` computes `partial` (a gap > 30 s) and answers null for an unknown id. Verify in `test/history-store.test.ts`:
  - Readings come back oldest first, round-tripping every field;
  - `since` is clamped to 24 h;
  - a Trace with a 40 s gap is partial and one with 10 s steps is not;
  - a duplicate `t` is ignored without throwing.
- [ ] 2.3 Add `pruneReadings(now, currentTaskId)` with injectable `readingsMaxRows` and a 24 h untraced age (D4). Verify in `test/history-store.test.ts`:
  - untraced Readings older than 24 h go and traced ones stay;
  - with a cap of 10 rows, the oldest Traces are deleted whole, the current task's Trace is never deleted, and the jobs stay in `list()`.

## 3. Recorder

- [ ] 3.1 Add `src/reading-recorder.ts` (D1): the latest snapshot from `change`, a 10 s timer, recording only while online, and a `reading` event after the write. Verify in `test/reading-recorder.test.ts` with `node:test` mock timers:
  - pushes every 3 s for 60 s give 6 Readings with the latest values;
  - a burst of 20 pushes in 1 s adds no extra Reading;
  - no Reading is recorded while the connection is `offline`, and recording resumes after `online`.
- [ ] 3.2 Add Trace assignment (D2): the running id, a 15-minute tail after the id goes empty, the tail ended by a new id, and the tail resumed from the last stored Reading on start. Verify in `test/reading-recorder.test.ts`:
  - the cool-down scenario puts Readings up to +15 min in the Trace and later ones outside it;
  - a new job at +5 min takes the following Readings;
  - a recorder created over an archive whose last Reading is a traced one from 5 minutes ago continues that tail.
- [ ] 3.3 Call `pruneReadings` at start and every hour (D4) and wire the recorder in `src/service.ts`, closed in `close()`. Verify:
  - in `test/reading-recorder.test.ts`, with mock timers, that pruning runs at start and after one hour;
  - in `test/service.test.ts`, that a service against the fake printer has stored Readings carrying the fixture job's `TaskId` after 10 s of mocked time.

## 4. API

- [ ] 4.1 Add `GET /api/readings` and `GET /api/history/trace` to `src/http-server.ts` (D5), behind `authorized()`, GET only, with 400 and 404 as the spec states. Verify with new cases in `test/http-server.test.ts`:
  - the window answers oldest first, and no `since` means 3 h;
  - `since=yesterday` answers 400 `bad-request`;
  - a known trace answers with `partial`, an unknown id answers 404 `not-found`, and a missing id answers 400;
  - no token answers 401, and `POST` answers 405.
- [ ] 4.2 Send the `reading` event on `/api/events` through a `ChangeFanOut` over the recorder (D5). Verify in `test/http-server.test.ts` that a connected stream receives `event: reading` with the Reading's JSON, and that the `status` and `history` events are unchanged.
- [ ] 4.3 Document both routes, the Reading fields, the Trace answer, the limits, and the `reading` event in `docs/api.md`, including its errors table. Verify that each documented `curl` command runs as written against `pnpm start:fake` (after group 5) and answers what the page shows.

## 5. Fake printer

- [ ] 5.1 Make `scripts/fake-print-simulation.ts` push `PrintSpeedPct` (100, with a 130 stretch), fans that follow the layer (the part fan from layer 3), and `CurrenCoord` with Z following the layer, and keep `test/support/fake-printer.ts` replaying fixtures unchanged (D10). Verify that `pnpm start:fake` serves `/api/status` with non-null speed, fans, and Z, and that `/api/readings` grows by one Reading every 10 s.

## 6. Dashboard charts

- [ ] 6.1 Add `web/charts.ts` with `chartModel(readings, range, now, hidden)` (D7): segments split at gaps > 30 s, target steps, state, light, and gap spans, a shared time scale, and axis ticks. Add `/charts.js` to `src/dashboard-files.ts` and to the `SHELL` list in `web/sw.ts`. Verify `test/charts.test.ts`:
  - the offline scenario gives one gap span from 16:20 to 16:28 and no segment crossing it;
  - the pause scenario gives a paused span;
  - hidden series give no segments;
  - each chart has one y scale (Temperatures in °C, Job 0 to 100).
- [ ] 6.2 Add the palette tokens `--series-1` … `--series-5` to both theme blocks of `web/style.css` (D8). Verify with the dataviz `validate_palette.js` for `--mode light` and `--mode dark` against the sheet surfaces: no FAIL. Record the command and its result in the task's commit message.
- [ ] 6.3 Add the renderer (SVG through `createElementNS`, no `innerHTML`), the readout model (nearest Reading within 30 s, otherwise "offline"; layer and Z included), and the legend toggles with `aria-pressed`. Verify in `test/charts.test.ts` that the readout of the 15:42 scenario lists every field, and that a time inside a gap reads "offline".
- [ ] 6.4 Add the Charts `<details>` between the status sheet and History in `web/index.html`, in History's style, open by default, with its state in `localStorage` under `charts-open` (D6). Add `ChartsLoader` (D7): "This job" from the trace route, the other ranges from `/api/readings`, appending `reading` events, reloading on reconnect, and no request while closed. Verify:
  - `test/charts.test.ts` covers the range default (a job running gives "This job", idle gives "3 h" with "This job" disabled);
  - `node scripts/visual-check.ts` reports a1 to h2 at their previous shares, so the visible area is unchanged.
- [ ] 6.5 Add the table view toggle (one row per minute, a header row, every series, layer, and Z). Verify in `test/charts.test.ts` that 30 minutes of Readings give 30 table rows with the expected columns.
- [ ] 6.6 Make history rows expandable (a button with `aria-expanded`) and show the job's Trace with the same charts, "Partial" when flagged, and "No chart for this print" on a 404, in `web/history.ts` and `web/app.ts`. Verify in `test/dashboard-history.test.ts` that the three outcomes render as specified.
- [ ] 6.7 Add the visual-check ids `i1` to `i5` to `scripts/visual-check.ts` with a fixed synthetic Readings mock, scrolled to the Charts section (D10), and list them in the script header and in `AGENTS.md`. Verify that `node scripts/visual-check.ts i1 i2 i3 i4 i5` produces both themes per id with no horizontal scroll at 360 px.

## 7. Docs and integration

- [ ] 7.1 Update `README.md` (dashboard features) and `ROADMAP.md`: the charts item leaves "Later", and a "Prometheus `/metrics`" item stays as later work. Verify by reading both files: no remaining mention of in-memory-only charts.
- [ ] 7.2 End-to-end check: `pnpm typecheck`, `pnpm test`, then `pnpm start:fake`, the dashboard opened at 360 px and at 1280 px in both themes, and every chart behaviour from the dashboard spec tried by hand: open and close remembered, the four ranges, the cursor, the legend, the table, a gap after `kill -USR2` twice, and a history row's Trace. Report any mismatch before review.
- [ ] 7.3 After the user approves the screens, copy the `i1` to `i5` shots to `docs/design/reference/` as the references (grilling Q16). Verify that `node scripts/visual-check.ts i1 i2 i3 i4 i5` reports a share near 0 for each.

## Workflow follow-up

- Archive the change after the PR merges (`/opsx:archive`).
- Delete the `prototype/charts-q9` branch once the change is archived.
