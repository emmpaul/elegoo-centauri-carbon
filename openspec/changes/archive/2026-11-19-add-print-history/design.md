# Design

## Context

See `proposal.md` for the motivation. What the code does today, and what this design
builds on:

- `src/sdcp-client.ts` already allows `GET_PRINTER_HISTORY_ID` (320) and
  `GET_PRINTER_TASK_DETAIL` (321). `src/service.ts` sends 321 for the job that just ended
  (the `taskErrorCode` callback of `EventDetector`); nothing sends 320 yet.
- The wire facts, from the fixtures (`docs/sdcp-protocol.md`, Command ids): Cmd 320
  answers `Data.Data.HistoryData`, a list of `TaskId`s newest first (26 in
  `print-complete.json#26`). Cmd 321 takes `{Id: [...]}` and answers
  `Data.Data.HistoryDetailList[]`; the web UI asks for all 26 ids in one request
  (`print-complete.json#27`, `#28`). Each entry has `TaskId`, `TaskName`
  (`/local/<file>`), `BeginTime` and `EndTime` (Unix seconds), `TaskStatus`,
  `SliceInformation.total_layer_numbers`, `AlreadyPrintLayer`, `ErrorStatusReason`, and
  `Thumbnail` (`http://<printer>/board-resource/history_image/<TaskId>.png`).
- `TaskStatus` values seen: 4 while running (also with a non-zero `EndTime`,
  `print-complete.json#17`), 1 after completion, and 3 on five jobs that all stopped
  before their last layer (`print-complete.json#28`). Stop was never captured, so 3 means
  "stopped" by inference only. `ErrorStatusReason` was 0 on every entry.
- Nothing has ever fetched a `Thumbnail` URL; only the field is observed.
- `PrinterSession` emits `state` (`online` on the first status of each connection);
  `EventDetector` emits `finished`, `failed`, and `stopped` once per job.
- `createApiServer` routes exact paths, keeps the camera optional, and accepts the token
  as a bearer header or `?token=` (which `<img>` needs). `/api/events` sends `status`
  events only.
- The dashboard has no bundler: `src/dashboard-files.ts` serves an allow-list and strips
  types; `web/sw.ts` pre-caches the shell list and never touches `/api/`. The status sheet
  has `min-height` of the viewport, so anything after it in `.dash` starts below the fold
  in every visual-check state (360 × 780 and 1280 × 660).
- Node 26 ships `node:sqlite` (`DatabaseSync`) with no flag.

## Goals / Non-Goals

**Goals:**

- One small archive module that owns the schema, so the sync, the API, and later features
  (time-lapse links) read jobs through it.
- Sync that reuses the session and its allow-list and can never disturb status, controls,
  or events.
- Deterministic tests: `:memory:` or temp-dir databases, the fake printer on 127.0.0.1,
  and injected limits and timers.

**Non-Goals:**

- Deleting history on the printer (Cmd 322, *static-only*) or in the archive from the API.
- Time-lapse links, a job detail page, search, filters, or export.
- Several printers: the archive has no printer column (the roadmap lists multi-printer
  as an idea; a later schema version can add one).
- Keeping status samples or charts (separate roadmap item).

## Decisions

### D1. Archive: `node:sqlite` in `src/history-store.ts`

`HistoryStore.open(path)` opens a `DatabaseSync` (`path` may be `:memory:`), sets
`journal_mode=WAL` and `foreign_keys=ON`, then runs `BEGIN IMMEDIATE; COMMIT` so a
read-only file or directory fails at start-up and not on the first write. Errors are
rethrown as `cannot open the history archive at <path> (set DATA_DIR or dataDir to a
writable directory): <cause>`.

Schema version 1 (`PRAGMA user_version = 1`):

- `jobs(task_id TEXT PRIMARY KEY, file_name TEXT NOT NULL, begin_time INTEGER NOT NULL,
  end_time INTEGER NOT NULL, task_status INTEGER NOT NULL, error_code INTEGER NOT NULL,
  layers_printed INTEGER NOT NULL, layers_total INTEGER NOT NULL, thumbnail_url TEXT,
  thumbnail_attempts INTEGER NOT NULL DEFAULT 0, detail TEXT NOT NULL, updated_at INTEGER
  NOT NULL)` with an index on `(begin_time DESC, task_id DESC)`. `detail` is the raw
  entry JSON, kept so a later feature can read a field without a re-sync.
- `thumbnails(task_id TEXT PRIMARY KEY REFERENCES jobs ON DELETE CASCADE, content_type
  TEXT NOT NULL, bytes BLOB NOT NULL, size INTEGER NOT NULL)`.

Migrations are an ordered list of SQL steps; the step from version *n* to *n+1* runs in
one transaction with the `user_version` update. A file with a higher version than the
list knows is refused (spec: Archive schema version).

The store stays synchronous: each call is one small query on a single-process database,
which is shorter than the JSON work the service already does per status push.

*Alternatives:* a JSON file (rewrite on every change, no paging query, no safe partial
writes); `better-sqlite3` (a native npm dependency, which the user ruled out).

### D2. `dataDir` setting

`Config.dataDir: string`, default `"data"`; config file key `dataDir` (non-empty string),
env `DATA_DIR` (wins, empty counts as unset, as for the other variables). `main.ts`
resolves it against the working directory, creates it with `mkdirSync(..., {recursive:
true})`, and passes `join(dataDir, "history.sqlite")` to `startService` as `historyPath`.
`ServiceOptions.historyPath` defaults to `:memory:`, so the existing tests and
`scripts/run-fake-service.ts` need no data directory. `startService` opens the archive
first, before the session or the server, so a failure leaves nothing open.

### D3. Normalizing an entry

`jobFromDetail(entry)` returns null without a non-empty string `TaskId` and otherwise
reads: `file_name` = last path segment of `TaskName`; numbers default to 0 when missing or
not finite. Outcome (spec: Job outcome) is computed on read, in one function, from
`task_status` and `error_code`, so a later correction of the code meanings needs no
migration. The API's times are milliseconds (`BeginTime * 1000`), null when 0; `endedAt`
and `durationSeconds` are null while the outcome is `running`; duration is
`EndTime - BeginTime` (wall time, which is what the start and end columns show).

`upsert(jobs)` runs in one transaction and returns how many rows were inserted or had a
changed field (ignoring `updated_at`), which drives the change event (D7).

### D4. Sync in `src/history-sync.ts`

`HistorySync` takes the session (`send`), the store, the printer host, a `fetch`
function, the logger, and limits. `trigger()` starts a sync, or, while one runs, sets a
flag so exactly one more runs after it (spec: Overlapping triggers). A sync:

1. sends 320, and reads `HistoryData` as an array of strings (anything else is a
   malformed answer);
2. keeps the ids the store lacks or holds with `task_status` 4;
3. sends 321 for them in chunks of at most 26 ids (the size the web UI sends), and
   upserts each answer's valid entries;
4. fetches missing thumbnails (D5), one at a time;
5. emits `change` once if anything was stored.

A non-zero `Ack`, a timeout, or `NotConnectedError` ends that sync with one warning;
already committed chunks stay. Neither 320 nor 321 timeouts touch session liveness
(`PrinterSession` only drops on a status timeout).

`service.ts` triggers it on `session` `state` → `online` and on detector events
`finished`, `failed`, and `stopped`. Because a job can still read `TaskStatus` 4 right
after its end push, a sync that leaves a job at 4 while the status snapshot's print state
is not active schedules one follow-up sync after 10 s, at most 3 in a row.

### D5. Thumbnails

Only URLs with protocol `http:` and hostname equal to the printer host (from
`new URL(printerUrl).hostname`) are fetched, with `redirect: "error"` and
`AbortSignal.timeout(10_000)`. The answer must be 200 with `image/png` or `image/jpeg`;
the body is read in chunks and aborted past 1 MiB (also when `Content-Length` says so).
Each failure increments `thumbnail_attempts`; at 3 the job is no longer tried. After a
store, while the sum of `size` is over 100 MiB, the thumbnail of the job with the oldest
`begin_time` is deleted. Limits and `fetch` are constructor options so tests use small
values and a fake server. `docs/sdcp-protocol.md` notes the fetch as unconfirmed until
it is seen working on the real printer.

### D6. API

`createApiServer` takes an optional `history` (`list(before, limit)`,
`thumbnail(id)`, and a `change` event); without it the routes do not exist, as for the
camera. Routes, both GET only and behind `authorized()`:

- `GET /api/history?limit=&before=` → `{"jobs": [...], "next": "<cursor>" | null}`.
  The cursor is `<beginTime>_<taskId>` of the page's last job, documented as opaque and
  checked against `^\d{1,12}_[A-Za-z0-9-]{1,64}$`. The query is `ORDER BY begin_time
  DESC, task_id DESC` with `(begin_time, task_id) < (?, ?)` for `before`, asking for
  `limit + 1` rows to know whether `next` exists.
- `GET /api/history/thumbnail?id=<taskId>` → the bytes with the stored `Content-Type`,
  `Content-Length`, `Cache-Control: private, max-age=86400`, and
  `X-Content-Type-Options: nosniff`; 404 `not-found` otherwise. A query route (not
  `/api/history/<id>`) keeps the exact-path router as it is.

A job in the list:

```json
{"id": "27febebe-…", "fileName": "test-print-1.gcode", "startedAt": 1794600358000,
 "endedAt": 1794604693000, "durationSeconds": 4335,
 "layers": {"printed": 180, "total": 180}, "outcome": "completed", "taskStatus": 1,
 "errorCode": null, "thumbnail": "/api/history/thumbnail?id=27febebe-…"}
```

### D7. `history` event on `/api/events`

`streamEvents` also listens to the history source's `change` and writes
`event: history\ndata: {}\n\n`. EventSource clients that only listen for `status`
ignore it. One event per sync that changed something, so a 26-job first sync is one
event.

### D8. Dashboard section

Markup: a `<details class="hist" data-field="history">` after the status `<section>` in
`main.dash`, with `<summary class="hist__head">` "History" (44 px target, native
expanded state for assistive technology) and a list, a status line, a Retry button, and
an end sentinel. On a laptop it spans the page width below the camera and panel; on a
phone it follows the sheet on the same surface tokens. Styles use the existing tokens
(`--text*`, `--line`, `--raise`, tone colours), so both themes follow from `:root`.

`web/history.ts` (served as `/history.js`, added to the service-worker shell with the
cache name bumped) holds:

- pure view functions: `historyRowView(job, now)` → thumbnail src or placeholder, name,
  start (`HH:MM`, or `D Mon HH:MM` on another day, from `clock()` rules in `view.ts`), end,
  duration via `duration()`, `"<printed> / <total>"` (`"—"` for an unknown total), outcome
  label and tone (`Completed` ok, `Stopped` warn, `Printing` info, `Error <code>` bad with
  ` · filament low` for 45, `Unknown (<taskStatus>)` neutral);
- a small controller created with an injected `fetch` and element refs: `open()` loads
  the first page once, an `IntersectionObserver` on the sentinel loads `before=<next>`
  with an in-flight guard and stops at `next: null`, `reload()` replaces the list from the
  first page, and a failure shows "History unavailable" with Retry. A 401 goes to the
  existing token screen.

`web/app.ts` creates it, restores the open choice from `localStorage` key `history-open`
(reads and writes in `try/catch`), and calls `reload()` on the event stream's `history`
event while open. Thumbnails are `<img loading="lazy" alt="">` with the token in the
query, since the name is in the row.

### D9. Fake printer and fake service

`FakePrinter` gets an option `history: { entries: Record<string, unknown>[] }` (mutable):
320 answers the entries' `TaskId`s in order, 321 the entries whose ids were asked, in the
order asked. Entries in `replies` still win, so `FAKE_REPLIES=320=silent` works.
`test/support/fake-thumbnails.ts` is an HTTP server on 127.0.0.1 that answers
`/board-resource/history_image/<id>.png` from a function and counts requests.

`scripts/fake-print-simulation.ts` seeds the entries from `print-complete.json#28` (26
redacted jobs) with `Thumbnail` rewritten to the fake thumbnail server, plus the
simulated job (its `TaskId` and file name from the status, `TaskStatus` 4), and on
completion sets it to 1 with `EndTime` and all layers, on stop to 3. Thumbnails are the
committed camera frames (`image/jpeg`). Synthetic entries use `test-print-<n>.gcode`
names and no LAN address.

### D10. Visual check

Two states, `h1` (dark) and `h2` (light), both 360 wide, status variant `idle`. The mock
server answers `/api/history` with five fixed jobs relative to `NOW` (completed today,
stopped, failed 45, completed on an earlier day, one without a thumbnail) and
`/api/history/thumbnail` with `test/fixtures/camera-frame-1.jpg`; every other state gets
an empty page (no request is made while collapsed). Interaction `history`: click the
"History" summary, wait for the rows, scroll the section to the top of the viewport; the
device-clock overlay is skipped for these ids. The references are the approved shots
copied to `docs/design/reference/h1.png` and `h2.png`.

### D11. Container

`Dockerfile`: `RUN mkdir -p /data && chown node:node /data`, `ENV DATA_DIR=/data`, and
`VOLUME /data` before `USER node`. `compose.yaml` mounts a named volume
`printer-data:/data`; Docker copies the image's ownership into an empty named volume, so
the `node` user can write it. `.dockerignore` (allow-list) already keeps a local `data/`
out of the image; `.gitignore` gets `data/`.

## Risks / Trade-offs

- [`TaskStatus` 3 read as "stopped" by inference] → the raw value is kept and served, the
  mapping is one function computed on read, and `docs/sdcp-protocol.md` labels it.
- [No non-zero `ErrorStatusReason` seen] → `failed` comes only from a non-zero code, the
  same rule the event detector uses; tests use synthetic entries.
- [Thumbnail fetch never seen on the wire] → host check, size and time limits, 3
  attempts, warnings only; a job without a thumbnail still lists.
- [A job stays `running` if the printer drops it before it settles] → it is re-requested
  on every sync while listed; once unlisted it keeps its last state. Accepted.
- [`node:sqlite` API changes in a later Node] → only `src/history-store.ts` imports it.
- [Job rows grow without limit] → about 1 KB per job; thousands of prints are a few MB.
  Thumbnails, the large part, are capped at 100 MiB.
- [A compose file copied before this change has no volume] → the `VOLUME` line still
  keeps data per container, and `docs/deployment.md` says to add the named volume before
  upgrading; recreating without it starts an empty archive, which the next sync refills
  with the printer's own list.

## Migration Plan

1. Release as usual; the image now writes `/data`.
2. Operators update `compose.yaml` (named volume) before `docker compose up -d`; the first
   connect fills the archive from the printer's list.
3. Rollback: an older image ignores `/data`; the volume keeps the archive for the next
   upgrade. A later schema version migrates forward only, so rolling back after a schema
   upgrade means the older image refuses the newer file; the deployment docs say to keep a
   copy of the volume before upgrading across a schema change.
