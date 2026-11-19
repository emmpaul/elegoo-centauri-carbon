## Context

The specs of `add-print-history` were frozen after planning, and its review found four
places where the implementation follows the design but the spec text differs. The code
is released (v1.0.0-rc.6) and running on the home node. This change edits only the spec
text and adds one test.

## Goals / Non-Goals

**Goals:** the specs match the shipped behavior of `src/history-sync.ts`,
`src/http-server.ts`, and `web/app.ts`.

**Non-Goals:** changing any behavior; a DOM test harness for `web/app.ts`.

## Decisions

### D1. Keep committed chunks rather than make a sync atomic

A sync stores Cmd 321 answers chunk by chunk (at most 26 ids each). Rolling back stored
chunks when a later one fails would discard valid jobs the printer already reported; the
next sync asks only for what is still missing. The spec states this instead of asking for
all-or-nothing. Each chunk is still stored in one transaction, so a chunk is either fully
stored or not at all.

### D2. Follow-up syncs in the spec, with their numbers

The printer can still report `TaskStatus` 4 right after a job's end push. The follow-up
rule (10 s delay, at most 3 in a row, none while a print is active, a new trigger starts
a new run) becomes a requirement scenario, because a client depends on the ended job
settling without another trigger.

### D3. Reconnect reload stays untested

The reload after a reconnect lives in `web/app.ts` connection wiring, which has no DOM
harness. `HistoryList.changed()` itself is tested in `test/dashboard-history.test.ts`. The
scenario is specified, and the gap is recorded here instead of building a harness in a
spec-only change.

## Risks / Trade-offs

- [The spec now allows a partly updated archive after a failed sync] → no stored job is
  ever deleted or corrupted; the next sync fills the rest.
