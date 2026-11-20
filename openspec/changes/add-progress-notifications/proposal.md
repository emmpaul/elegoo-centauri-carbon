# Proposal

## Why

Today the owner hears about a print when it starts and when it ends, but not at the two
points where a look at the printer pays off most: right after the first layer, when most
prints that are going to fail do (poor adhesion, a nozzle too high or too low), and a few
minutes before the end, in time to walk over and take the part off. The service already
reads the layer and the time left in every status push, so both can be Events like the
others (the "Progress notifications" item in `ROADMAP.md`).

## What Changes

- Two new Events, both **off by default**:
  - `first-layer`: the print has finished its first layer (the printer reports layer 2
    or later after this job was seen on layer 0 or 1).
  - `almost-done`: about ten minutes are left (the printer's remaining time drops to
    600 seconds or less after this job was seen with more than 600 seconds left).
- They are turned on like any other Event: `events["first-layer"]` /
  `events["almost-done"]` in `config.json`, or by listing them in `NOTIFY_EVENTS`. The
  seven existing Events stay on by default, so existing installs send exactly what they
  send today.
- Each is sent at most once per job, with the same dedupe as the other job Events (keyed
  on the job's `TaskId`): repeated pushes, reconnects, a pause and resume, or the
  estimate jumping back above ten minutes never send it twice.
- Both are detected only from a crossing seen while the service watches the job, so the
  stale layer and time of the previous job, a service restart late in a print, or a print
  shorter than ten minutes (or with one layer) never send a misleading one.
- With `ntfy.photos` on, the `first-layer` Notification carries a Photo (a look at the
  first layer is the point of it), with the same 5 s limit, text-only fallback, and
  opt-in Photo light as the other Photo Events. `almost-done` is text-only.
- Messages: "First layer done" / `<file> finished its first layer.` and "Almost done" /
  `<file> has about <n> min left (<progress>%).`
- Docs: `docs/notifications.md` (settings, the "What you get" table, Photos), the README
  configuration table, the `docs/deployment.md` env table, `config.example.json`,
  `GLOSSARY.md` (the Event list), and `ROADMAP.md` (the item removed).

Out of scope: a configurable threshold (ten minutes is fixed), other milestones (every n
percent, a chosen layer), a Photo on `almost-done`, new SDCP commands, and any change to
the HTTP API or the dashboard.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `print-notifications`: adds the `first-layer` and `almost-done` Events (detection from
  the layer and remaining time, off by default, once per job), and adds `first-layer` to
  the Events whose Notifications carry a Photo.

## Impact

- Code: `src/config.ts` (two event types, off by default), `src/event-detector.ts`
  (milestone tracking per job, a `remainingSeconds` field on `PrintEvent`),
  `src/notifier.ts` (two messages), `src/notification-photo.ts` (`PHOTO_EVENTS`).
- Tests: `test/config.test.ts`, `test/event-detector.test.ts`, `test/notifier.test.ts`,
  `test/notification-photo.test.ts`, `test/service.test.ts`; synthetic status pushes
  only, no new fixture.
- Printer: no new command. The fields read, `PrintInfo.CurrentLayer`, `TotalLayer`,
  `CurrentTicks`, and `TotalTicks`, are *observed* in `docs/sdcp-protocol.md`.
- No HTTP API change (`docs/api.md` unchanged), no dashboard change, no new dependency.
