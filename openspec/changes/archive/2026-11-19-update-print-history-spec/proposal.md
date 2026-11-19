## Why

`add-print-history` shipped in v1.0.0-rc.6 following its design (D4, D8), but in four
places the `print-history` and `printer-dashboard` specs say something different or say
nothing. The PR #29 review waived these as spec wording, to be fixed in a follow-up. This
change makes the specs describe what the service does, so later changes and reviews start
from accurate requirements.

## What Changes

- **Sync failures are contained:** a failed sync keeps the Cmd 321 chunks it already
  stored instead of leaving the archive exactly as before the sync (design D4).
- **Sync from the printer:** describes the follow-up syncs: a job still read as running
  while no print is active is synced again after 10 s, at most 3 times in a row.
- **Thumbnail API:** a missing or empty `id` answers 400 `bad-request`, as `docs/api.md`
  already says.
- **History refresh and empty states:** the dashboard also reloads history after the
  service connection comes back, and after a failed load once the service answers again.

No code changes: each behavior is already implemented, and all but the dashboard reload
are tested. One test is added for the kept chunks.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `print-history`: partial-sync behavior, follow-up syncs, thumbnail 400.
- `printer-dashboard`: history reload after a reconnect.

## Impact

- `openspec/specs/print-history/spec.md`, `openspec/specs/printer-dashboard/spec.md` (on
  archive).
- `test/history-sync.test.ts`: one test for chunks kept after a later chunk fails.
- No runtime, API, or data change.
