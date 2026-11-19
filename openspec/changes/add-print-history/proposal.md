# Proposal

## Why

The dashboard only shows the job that is running now: once a print ends, its name, times,
and outcome are gone, and the printer itself keeps only a short list that it trims on its
own. The printer already answers two observed, read-only commands for its job history
(Cmd 320 and Cmd 321, see `docs/sdcp-protocol.md`), so a lasting history needs no new
protocol work. This is the "Print history" item of `ROADMAP.md`.

## What Changes

- A local job archive: an SQLite database (Node's built-in `node:sqlite`, no new npm
  dependency, no extra container) in a data directory set by a new `dataDir` config key
  and `DATA_DIR` environment variable. The archive carries a schema version so later
  changes can migrate it.
- History sync: on every connect, and when a job ends, the service asks the printer for its
  history ids (Cmd 320) and the details (Cmd 321) of ids it has not stored yet or that were
  still running. Jobs stay in the archive after the printer drops them, so history shows
  while the printer is offline.
- Thumbnails: the service fetches each job's thumbnail from the printer once, stores the
  bytes in the archive with a per-image and a total size limit, and serves them itself.
- API: `GET /api/history` (read-only, newest first, paginated with `before` and `limit`)
  and `GET /api/history/thumbnail?id=<taskId>`, behind the same token as the rest of the
  API; `/api/events` adds a `history` event when the archive changes. Documented in
  `docs/api.md`.
- Dashboard: a collapsible "History" section below the status sheet, in the existing style
  and both themes, that loads more rows on scroll. Each row shows the thumbnail, name,
  start and end time, duration, layers printed, and the outcome with the failure reason.
  Two new visual-check states (`h1` dark, `h2` light) with reference images generated from
  the implementation.
- Fake printer: answers Cmd 320 and Cmd 321 from redacted fixture data and serves
  thumbnails, so `pnpm start:fake` shows a history.
- Container: the image creates `/data` owned by the `node` user, sets `DATA_DIR=/data`,
  and declares it a volume; `compose.yaml` and `docs/deployment.md` mount a named volume
  there so an image update keeps the archive.

No command is added to the allow-list: `src/sdcp-client.ts` already allows 320 and 321.

## Capabilities

### New Capabilities

- `print-history`: the archive of past print jobs: syncing it from the printer, keeping it
  across printer trims and restarts, its storage location and limits, and the read-only
  history and thumbnail API.

### Modified Capabilities

- `printer-dashboard`: adds the History section requirement.
- `container-deployment`: the image reads `DATA_DIR` too, and keeps the archive on a
  volume across image updates.

## Impact

- New code: `src/history-store.ts` (archive), `src/history-sync.ts` (sync and thumbnails),
  `web/history.ts` (dashboard section view and loader).
- Changed code: `src/config.ts`, `src/service.ts`, `src/main.ts`, `src/http-server.ts`,
  `src/dashboard-files.ts`, `web/index.html`, `web/app.ts`, `web/style.css`, `web/sw.ts`,
  `test/support/fake-printer.ts`, `scripts/fake-print-simulation.ts`,
  `scripts/run-fake-service.ts`, `scripts/visual-check.ts`.
- Container and docs: `Dockerfile`, `compose.yaml`, `printer.env.example`,
  `config.example.json`, `.gitignore`, `README.md`, `docs/api.md`, `docs/deployment.md`,
  `docs/sdcp-protocol.md` (thumbnail fetch note), `AGENTS.md` (state ids), and
  `docs/design/reference/h1.png`, `h2.png`.
- Runtime: the service now writes to disk. A data directory that cannot be opened or
  written stops the service at start-up with a clear message.
