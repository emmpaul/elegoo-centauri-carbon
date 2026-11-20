# Design

## Context

See `proposal.md` for the why and `specs/print-notifications/spec.md` for the required
behavior. Terms follow `GLOSSARY.md`: an **Event** is the occurrence, a **Notification**
the push about it, a **Photo** the camera still attached to it.

What exists today:

- `src/status-store.ts`: every snapshot carries `layer: { current, total }` (from
  `PrintInfo.CurrentLayer` / `TotalLayer`) and `remaining` in seconds
  (`max(0, round(TotalTicks - CurrentTicks))`, null when either is missing). Both fields
  are *observed* in `docs/sdcp-protocol.md`. Partial pushes keep the previous raw
  `PrintInfo` values.
- `src/event-detector.ts`: one `Job` per running print (key = `TaskId`, else file name +
  start time), created on the first active snapshot that names the job. Every emission
  goes through `emitOnce(key)` with keys such as `${job.key}:started`; the `emitted` set
  lives for the process. The first snapshot with a known machine state is the
  *baseline*: joining a running job emits no `started` and no `paused`.
- `src/config.ts`: `EVENT_TYPES` (7 names) and `events: Record<EventType, boolean>`,
  all `true` by default; the file's `events` object sets single entries, `NOTIFY_EVENTS`
  lists the enabled ones (all others off, `none` = all off). Unknown names are an error.
- `src/notifier.ts`: `formatEvent` is an exhaustive `switch` over `EventType`;
  `NtfyNotifier.notify` drops events whose `events[type]` is false.
- `src/notification-photo.ts`: `PHOTO_EVENTS` (finished, failed, stopped, paused);
  `src/service.ts` passes a Photo provider only for those.

What the recorded fixtures show about the two fields:

- `CurrentLayer` counts from 1 and is the layer being printed: `connect-printing.json`
  reports layer 12 of 12 at 79–87 % progress, and a finished job stays on 12 of 12
  (`print-complete.json`).
- A new job starts on `CurrentLayer` 0 with `TotalLayer` and `TotalTicks` already set
  while the printer heats and levels (`connect-idle.json`, layer 0 of 640,
  `TotalTicks` 12819, `CurrentTicks` 0). Before that, the idle printer still reports the
  previous job's 12 of 12 and 397.5 of 399 ticks, and one push in between has all four
  at 0.
- `TotalTicks` stayed constant through every recorded job; whether the printer revises
  it during a long print is not recorded (Risks).

## Goals / Non-Goals

**Goals:**

- Two opt-in Events derived only from the snapshot, through the existing detector,
  notifier, and Photo path, with no new module and no new setting shape.
- No false Event from the previous job's stale values, from joining a print late, or
  from an estimate that wobbles around the threshold.
- Existing installs behave exactly as before.

**Non-Goals:**

- A configurable threshold or more milestones; a Photo on `almost-done`; showing
  milestones on the dashboard or in the HTTP API; storing them in the print history;
  any printer command.

## Decisions

### D1. Two event types, off by default

`EVENT_TYPES` gains `"first-layer"` and `"almost-done"` (appended, so the existing order
and messages stay). `defaultConfig()` sets them `false` and every other type `true`
(a `DEFAULT_OFF_EVENTS` set next to `EVENT_TYPES`). Nothing else in config parsing
changes: `events["first-layer"]: true` in the file turns one on, `NOTIFY_EVENTS` lists
it like any event (and, as today, turns off every event it doesn't list), and an
unknown name is still an error that lists the known ones.

*Alternative:* a separate switch such as `ntfy.progress` / `NTFY_PROGRESS=1`, like
`ntfy.photos`. Rejected: it would be a second place deciding whether an Event is sent,
with a precedence rule against `events` and `NOTIFY_EVENTS` to document and test. The
`events` map already is the per-Event on/off setting, with a file form and an env form,
so the progress Events reuse it. The cost is that turning one on through the environment
means listing every wanted event in `NOTIFY_EVENTS`; the docs show a full example.

### D2. Detection: a crossing seen within the same job

`Job` gains two flags, `layerArmed` and `remainingArmed`, both false when the job is
created. In `trackActive`, after the job's fields are updated from the snapshot, and on
every active snapshot (baseline included):

- `first-layer`: if `snapshot.layer.current` is 0 or 1, set `layerArmed`. If
  `layerArmed` and `snapshot.layer.current >= 2`, emit once with key
  `${job.key}:first-layer`.
- `almost-done`: if `snapshot.remaining > 600`, set `remainingArmed`. If
  `remainingArmed` and `snapshot.remaining !== null && snapshot.remaining <= 600`, emit
  once with key `${job.key}:almost-done`. The threshold is `ALMOST_DONE_SECONDS = 600`,
  a constant.

Null values neither arm nor fire. The flags never reset within a job, and `emitOnce`
keys on the job, so a wobble back above 600 s, a pause, or a reconnect never repeats an
Event; a new job gets a new `Job` and fresh flags.

Why arming instead of a plain threshold:

- The first active snapshot of a new job can still carry the previous job's layer
  (12 ≥ 2) and remaining time (1 s ≤ 600): neither arms, so neither fires. The new job's
  own layer 0 and full estimate arm them afterwards.
- Joining late (service restart on layer 5 or with 5 minutes left) sees no arming value,
  so nothing is sent for a milestone the owner may already have been told about.
  Joining early (layer 0 or 1, or more than 10 minutes left) arms as usual, so a restart
  during the first layer still sends `first-layer`. The baseline rule for `started` is
  unchanged.
- A print with one layer never reaches layer 2, and a print estimated at 10 minutes or
  less never shows more than 600 s: neither gets a misleading Event.

The detector checks only the reported values, not the print state: during a pause or a
material change the layer and the ticks do not move, so they cannot cross.

*Alternative:* fire when `remaining <= 600` and `progress < 100` without arming. Rejected:
the stale previous-job values and late joins would send it at once.

### D3. Event fields and messages

`PrintEvent` gains `remainingSeconds: number | null`: the snapshot's `remaining` on
`almost-done`, null on every other Event (set in `event()`, so existing Events and their
tests only gain a null field). `first-layer` and `almost-done` are built with
`jobEvent()`, so they carry the file name, progress, job id, and elapsed time like the
other job Events. `describeEvent` in `src/service.ts` needs no change.

`formatEvent` (priority 3 for both):

| Event | Title | Message | Tags |
| --- | --- | --- | --- |
| `first-layer` | `First layer done` | `<file> finished its first layer.` | `mag` |
| `almost-done` | `Almost done` | `<file> has about <n> min left<at>.` | `hourglass_flowing_sand` |

`<file>` falls back to `The print` as today, `<n>` is
`max(1, ceil(remainingSeconds / 60))` (10 at the usual crossing; the field is never null
on this Event, and a null falls back to 10), and `<at>` is ` (<progress>%)` when the
progress is known, else empty. Upload file names follow the existing rule:
`photo-first-layer.jpg`.

### D4. Photos

`PHOTO_EVENTS` gains `first-layer`; `almost-done` stays out. The service wiring, the
5 s limit, the text-only fallback, and the opt-in Photo light apply unchanged: the
first layer is mid-print like a pause, which ADR 0001 already covers (the light is
restored after the Photo). The upload's file name comes from the event label, so no
notifier change is needed beyond D3.

*Alternative:* a Photo on `almost-done` too. Rejected for now: ten minutes before the end
the part looks like it did at the previous check, and a Photo costs an attachment upload
(ntfy.sh quota) and, with the Photo light, an automatic light command.

### D5. Docs

- `docs/notifications.md`: the intro sentence, the `events` bullet ("All are on by
  default" becomes "all on by default except `first-layer` and `almost-done`"), the
  config example (both keys `false`), an `NOTIFY_EVENTS` example that turns them on
  (`NOTIFY_EVENTS=started,finished,failed,paused,stopped,offline,online,first-layer,almost-done`),
  two rows in "What you get", a note on when each fires and when it doesn't (late join,
  one-layer or short prints, once per job), and `first-layer` in the Photos event list.
- `README.md` configuration table and `docs/deployment.md` env table: the event list and
  the `NOTIFY_EVENTS` default ("all but `first-layer` and `almost-done`").
- `config.example.json`: both keys, `false`.
- `GLOSSARY.md`: the Event entry lists the two new Events.
- `ROADMAP.md`: remove the "Progress notifications" item the way "Camera snapshot in
  notifications" was removed; if `## Next` is left with no item, remove that heading too.

No change to `docs/api.md` or `docs/sdcp-protocol.md`.

## Risks / Trade-offs

- [`TotalTicks` may be revised by the printer during a long print (not recorded)] → An
  upward revision after the Event is harmless (once per job); a downward jump straight
  past 600 s still crosses and fires. The Event says "about". A live print is the check
  (Workflow follow-up in `tasks.md`).
- [`CurrentLayer` semantics are inferred from three recordings, not documented] → The
  fixtures agree on "layer being printed, from 1"; if a live print shows the first push
  of layer 1 as `CurrentLayer` 2, the Event comes one layer late, never early.
- [Ticks stop during a material change, so `remaining` is the slicer estimate minus
  printing time, not wall-clock] → Same number the dashboard shows; "about" in the
  message.
- [Enabling through the environment means listing every event in `NOTIFY_EVENTS`] →
  Documented with a full example; the config file sets single entries.
- [A `first-layer` Photo with the Photo light on sends an automatic light command
  mid-print] → Opt-in twice (the Event and the light), bounded and restored as for a
  pause (ADR 0001).

## Migration Plan

Nothing to migrate: both Events are off by default, and a config file or `NOTIFY_EVENTS`
written for the seven existing Events means the same as before. Rollback is turning the
Events off or reverting.
