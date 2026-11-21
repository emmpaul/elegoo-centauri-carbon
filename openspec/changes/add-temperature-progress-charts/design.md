# Design

## Context

See `proposal.md` for the motivation and the specs for the requirements. What the code
does today, and what this design builds on:

- **Status store.** `StatusStore` emits `change` with a fresh `StatusSnapshot` on every
  status push: about every 3 s, plus bursts about 130 ms apart on transitions. The
  printer clears `TaskId` (`""`) in the completion push and while idle.
- **Status push.** The push also carries `PrintInfo.PrintSpeedPct`,
  `CurrentFanSpeed.{ModelFan,AuxiliaryFan,BoxFan}`, and `CurrenCoord` (`"x,y,z"`), all
  *observed* (`docs/sdcp-protocol.md`). `status-store.ts` reads none of them yet.
- **Archive.** `HistoryStore` (`src/history-store.ts`) owns the one SQLite file. It
  creates and upgrades the file through its `MIGRATIONS` list (`PRAGMA user_version`,
  one transaction per step), and is the only module that touches the database. Jobs are
  never deleted; the thumbnails' total size is capped, oldest jobs' thumbnails first.
- **API server.** `createApiServer` routes exact paths. One `ChangeFanOut` per source
  serves every SSE client, and `/api/events` sends `status` and `history` events.
- **Dashboard.** The status sheet has a `min-height` of the viewport, so anything placed
  after it starts below the fold. That is why the History section changed none of the
  visual-check states, and the Charts section (variant (b) of grilling Q19) relies on the
  same thing. History is a `<details>` whose open state lives in `localStorage`
  (`history-open`), and its loader is `HistoryList` in `web/history.ts`.
- **Prototype.** Branch `prototype/charts-q9`, `web/prototype-charts.ts`. Variant A is
  the approved content: section, two charts, ranges, cursor. Its placement is replaced by
  (b), and it reads synthetic Readings.

## Goals / Non-Goals

**Goals:**

- One recorder that turns the snapshot stream into Readings on a fixed cadence, with no
  timing logic anywhere else.
- Readings in the existing archive, so a restart keeps the window and Traces, and the
  history module keeps owning the file.
- A chart view in the same shape as `view.ts`: pure functions from Readings to a
  drawable model, unit-tested without a browser.

**Non-Goals:**

- Downsampling on the server, or aggregates (min, max, average per bucket). The 24-hour
  range sends every Reading (see Risks).
- `/metrics`, export (CSV), and zoom or pan inside a chart.
- Charts of a job that ran while the service was down: there are no Readings for it.

## Decisions

### D1. `ReadingRecorder` samples on a timer, not on pushes

`src/reading-recorder.ts`:
- Listens to the store's `change` events and keeps only the latest snapshot.
- A 10-second interval timer records one Reading from that snapshot while
  `connection === "online"`, and nothing otherwise.
- Emits `reading` after the row is written.

*Why:* pushes are irregular (bursts, slower while paused), and a timer gives the fixed
grid the specs require. The latest value is the "last known value" the grilling settled
on.

*Alternatives:*
- Recording on each push and thinning later wastes writes.
- Averaging pushes within the 10 s hides short spikes, and nobody asked for it.

Tests drive the timer with `node:test` mock timers.

### D2. Trace assignment at write time, partial at read time

Each Reading row stores `task_id` (nullable). The recorder keeps the last non-empty
`taskId` and the time it went empty, then applies four rules:
- **Running job:** a Reading whose snapshot has a `taskId` gets it.
- **Tail:** a Reading without one, within 15 minutes of the last id going empty, gets
  that last id.
- **New job:** a new id ends the tail at once.
- **Restart:** on start, the recorder reads the last stored Reading. If it had a
  `task_id` and is less than 15 minutes old, the tail goes on, so a restart during
  cool-down keeps the tail.

`partial` is computed when a Trace is read: true when two consecutive Readings of the
Trace are more than 30 seconds apart, which is three missed Readings. It needs no
column, and it stays right if the rule changes.

*Why at write time:* the alternative, deriving Traces from job start and end times at
read time, depends on the Cmd 321 sync, which can be late, fail, or miss a job. The id on
the Reading is the only fact known at that instant. It is also how `event-detector`
already dedupes (on `TaskId`).

### D3. Schema step 2 in `HistoryStore`, explicit columns

`MIGRATIONS[1]` adds:

```sql
CREATE TABLE readings (
  t INTEGER PRIMARY KEY,          -- ms since epoch
  task_id TEXT,                   -- Trace it belongs to, or NULL
  nozzle REAL, nozzle_target REAL, bed REAL, bed_target REAL, chamber REAL,
  progress INTEGER, layer INTEGER, speed INTEGER,
  fan_part INTEGER, fan_aux INTEGER, fan_box INTEGER,
  z REAL, machine_state INTEGER, print_state INTEGER, light INTEGER
);
CREATE INDEX readings_task ON readings (task_id, t) WHERE task_id IS NOT NULL;
```

`HistoryStore` gains the methods `addReading`, `readingsSince`, `trace`, and
`pruneReadings`. A Reading stores the raw machine and print state codes, named on the
way out by the same mapping as the snapshot.

*Why explicit columns rather than a JSON `detail`:*
- **Pruning and caps:** they count rows and filter on `task_id` and `t`.
- **Size:** JSON per row would triple the file.
- **A later `/metrics`:** it can read the columns directly.

*Why no foreign key to `jobs`:* the Trace starts before the job row exists (the sync
runs when the job ends), and a job may never be synced.

### D4. Pruning: hourly and at start, in one transaction

`pruneReadings(now, currentTaskId)` does two things in one transaction:
- deletes `task_id IS NULL AND t < now - 24 h`;
- while the count is over `READINGS_MAX_ROWS` (2,000,000), deletes the whole Trace whose
  first Reading is oldest, skipping `currentTaskId`.

The recorder calls it at start and every hour. *Why:* this mirrors the thumbnail cap,
oldest first and whole units, and deleting per Trace never leaves half a chart. The
constants live in `history-store.ts` and are injectable for tests, like
`thumbnailTotalBytes`.

### D5. API shape

All three use the existing token check and error body.
- **`GET /api/readings?since=<ms>`** answers `{ "readings": Reading[] }`.
  - `since` defaults to now − 3 h and is clamped to now − 24 h.
  - A Reading is an object with named fields: `t`, `taskId`, `nozzle`, `nozzleTarget`,
    `bed`, `bedTarget`, `chamber`, `progress`, `layer`, `speed`, `fanPart`, `fanAux`,
    `fanBox`, `z`, `machineState`, `printState`, `light`. The two states are named, as
    in the snapshot.
- **`GET /api/history/trace?id=`** answers `{ "taskId", "partial", "readings" }`. It also
  serves the running job's Trace, which is how the dashboard loads "This job" (D7).
- **`reading` event** on `/api/events`: one Reading as JSON, through a new `ChangeFanOut`
  over the recorder.

*Why named fields over columnar arrays:* they match `docs/api.md`'s style, and the size
is acceptable on a LAN (see Risks).

### D6. Charts below the sheet, a sibling of History

`web/index.html` gains a `<details class="charts" open>` between the status sheet and the
History section. It uses the History section's structure and classes
(`hist__head`-style header, chevron), and its open state is stored under `charts-open`.

*Why:* grilling Q19 (b). Nothing above the fold moves, so states a1 to h2 and their
references stay valid, and the stop slide never moves away from the thumb.

### D7. `web/charts.ts`: a pure model, a thin renderer, a loader

- **`chartModel(readings, range, now, hidden)`** returns, for each chart, path segments
  split at gaps (> 30 s), target steps, state spans, light spans, gap spans, axis ticks,
  and the time scale. It has no DOM and is tested like `view.ts`.
- **`renderCharts(root, model, cursor)`** builds SVG with `createElementNS` and never
  sets `innerHTML`, so even text from the API can't inject markup.
- **`ChartsLoader`**, in the shape of `HistoryList`, holds the range:
  - **"This job":** loads `/api/history/trace?id=<snapshot.taskId>`.
  - **Other ranges:** loads `/api/readings?since=`.
  - **Events:** appends `reading` events and reloads on reconnect.
  - **Window:** keeps at most 24 h of Readings in memory.
- **History rows** become buttons with `aria-expanded`. Opening one loads its Trace
  through the same model and renderer: no range chips, the full Trace, and "Partial"
  when flagged.
- **Table view:** a toggle in the section header switches between chart and table. The
  table takes the Reading nearest each whole minute.

*Why hand-written SVG:* grilling Q12. There is no bundler, a library would have to be
copied into the repository and allow-listed, and the needs are narrow: lines, steps,
bands, a cursor.

### D8. Series palette: categorical slots, validated, separate from state tones

`style.css` gains `--series-1` … `--series-5` in both theme blocks: the dataviz
reference categorical order (blue, orange, aqua, yellow, magenta), snapped against the
sheet surfaces of each theme. They are checked with the dataviz `validate_palette.js`
for both modes before the tokens are committed.

Assignment (by entity, never by rank):
- **Temperatures:** nozzle orange, bed blue, chamber aqua.
- **Job:** progress blue, speed orange, part fan aqua, aux fan yellow, chamber fan
  magenta.

Targets use their heater's colour, dashed. State spans use neutral ink (shaded
`--text-3`), with the state named in the readout, never by colour alone.

*Why:* the prototype reused `--ok`, `--warn`, `--bad`, and `--info`, which already mean
print states on the same screen.

### D9. Snapshot fields

`StatusSnapshot` gains `speed: number | null`, `fans: { part, aux, box }` (each
`number | null`), and `z: number | null`. `z` is parsed from the third comma-separated
part of `CurrenCoord`, and it is null when that part is missing or not a finite number.
`docs/api.md`'s snapshot example is updated.

### D10. Fake printer and visual check

- **Fake print simulation:** it pushes a speed (100, with a stretch at 130), fans that
  follow the layer (part fan from layer 3), and a `CurrenCoord` whose Z follows the
  layer, so `pnpm start:fake` draws every series.
- **New `visual-check` ids**, each shot in both themes and scrolled to the Charts section
  the way h1 and h2 scroll to History:
  - `i1`: a job in progress on "This job";
  - `i2`: idle on 3 h;
  - `i3`: an offline gap;
  - `i4`: the section collapsed;
  - `i5`: a history row opened on a partial Trace.

  The mocked API serves fixed synthetic Readings. The references are those shots,
  committed once the user approves the implementation (grilling Q16).

## Risks / Trade-offs

- **[24 h payload]** About 8,640 Readings × ~250 bytes ≈ 2 MB of JSON for the 24-hour
  range. → It is only fetched on demand, on a LAN. If it proves slow on a phone, add a
  `step` parameter later without changing the default shape.
- **[Archive size]** 2,000,000 rows ≈ 150 to 250 MB on disk. → Enough for several hundred
  long jobs. The constant can come down in a patch; a config option waits until someone
  asks (grilling Q17).
- **[Write load]** One small insert every 10 s in WAL mode is negligible, even on an SD
  card.
- **[Tail misattribution]** A job started from the printer within 15 minutes, but without
  a `TaskId` in its first pushes, could land in the previous job's tail. → The tail ends
  as soon as any new id appears, so at most a few Readings are misplaced.
- **[Downgrade]** A file at schema version 2 is refused by an older service. → The
  existing rule, with a clear message. Rollback means restoring the data volume or
  deleting the archive file.
- **[Clock jumps]** `t` is the primary key. → A duplicate `t` after a clock step backwards
  is ignored (`INSERT OR IGNORE`): one lost Reading rather than a crash.

## Migration Plan

- The first start on this version upgrades the archive in place to schema version 2,
  in one transaction with its version bump. Jobs and thumbnails are untouched.
- Past jobs show "No chart for this print".
- Rollback: run the previous image with an archive restored from before the upgrade.
  Otherwise the old service refuses the newer file.
