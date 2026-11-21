# Proposal

## Why

The dashboard shows only the printer's values at this instant. Nobody can see how the
nozzle and bed got there, whether the chamber is still warming, when a pause or a
material change happened, or how a finished job went. The status pushes already carry
everything needed, so no protocol work is required. This is the "Temperature and progress
charts" item of `ROADMAP.md`, extended to the job values and to past jobs.

## What Changes

- **Readings.** The service records one Reading every 10 seconds while the printer is
  online. It records none while the printer is offline, so the gap stays visible. A Reading
  holds:
  - nozzle, bed, and chamber temperatures, with the nozzle and bed targets;
  - progress percent and current layer;
  - print speed percent and the three fan speeds;
  - Z height;
  - machine and print state;
  - light state.
- **Snapshot.** The snapshot gains print speed, the part, auxiliary, and chamber fan
  speeds, and Z height. All are *observed* fields of the status push
  (`docs/sdcp-protocol.md`).
- **Storage.** Readings are kept in the existing SQLite archive (a schema migration).
  - A job's Readings form its Trace. The Trace starts at the first Reading that carries
    the job's id, heat-up included, and ends 15 minutes after the job ends. A Trace with
    a gap while the service was down is marked partial.
  - Traces are kept with their jobs under a global row cap; the oldest jobs' Traces go
    first.
  - Readings outside any job are kept for 24 hours.
  - Recording is always on, with no new config option.
- **API.**
  - `GET /api/readings?since=<ms>` returns the recent Readings.
  - `GET /api/history/trace?id=<taskId>` returns a stored job's Trace.
  - `/api/events` gains a `reading` event per new Reading.

  All behind the access token, documented in `docs/api.md`.
- **Dashboard.** A collapsible "Charts" section under the status rows, open by default,
  with the open or closed choice remembered on the device. It is variant A of the
  prototype on branch `prototype/charts-q9`. Two charts share one time axis:
  - **Temperatures:** the three temperatures, with the targets as dashed steps.
  - **Job:** progress, speed, and the three fans, all in percent.

  Both charts carry:
  - a state strip, a light-on line, and hatched offline gaps;
  - a legend that toggles series;
  - a touch or hover cursor with a readout of all values, layer and Z included;
  - a table view.

  Range chips: "This job" (the default during a job), 1 h, 3 h (the default when idle),
  and 24 h. The charts are hand-written SVG with no new dependency.
- **History.** Opening a past job in the History section shows its Trace with the same
  charts.
- **Visual check.** New `visual-check` states for the Charts section, with references
  taken from the approved implementation.
- **Fake printer.** The fake printer pushes speed, fans, and Z, so `pnpm start:fake` draws
  every series.

Out of scope: a Prometheus `/metrics` endpoint (a later change) and the drift of the
remaining-time estimate.

## Capabilities

### New Capabilities

- `printer-readings`: recording Readings, Trace bounds and the partial mark, retention
  of Readings and Traces, the readings and trace API, and the `reading` event.

### Modified Capabilities

- `printer-connection`: the normalized live status adds print speed, fan speeds, and Z
  height.
- `print-history`: the archive upgrades a file from an older schema version instead of
  only opening files at the current one.
- `printer-dashboard`: adds the Charts section and the Trace of a past job in the
  History section.

## Impact

- **New code:**
  - `src/reading-recorder.ts`: samples the snapshot every 10 s and assigns Traces.
  - `web/charts.ts`: the SVG chart view and the section loader.
- **Changed code:**
  - `src/status-store.ts`, `src/history-store.ts` (migration, Reading tables, pruning),
    `src/service.ts`, `src/http-server.ts`, `src/dashboard-files.ts`;
  - `web/index.html`, `web/app.ts`, `web/history.ts`, `web/style.css`, `web/sw.ts`;
  - `scripts/fake-print-simulation.ts`, `test/support/fake-printer.ts`,
    `scripts/visual-check.ts`.
- **Docs:**
  - `docs/api.md`, `README.md`, `ROADMAP.md` (the item moves out, `/metrics` stays as
    later);
  - `AGENTS.md` (the new visual-check state ids);
  - `docs/design/reference/` (the new reference images).
- **Runtime:** the archive grows by about 8,640 rows a day while the printer is online
  and is bounded by the row cap. An archive written by this version is refused by an
  older service, as the existing schema version rule already requires.
