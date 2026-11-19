# Proposal

## Why

A "print finished" or "print failed" notification says what happened but not what the
print looks like, so the owner still has to open the dashboard to see a clean part, a
spaghetti mess, or why a print paused. The service already proxies the printer's camera
and ntfy accepts attachments, so a Photo can ride along with the Notification (the
"Camera snapshot in notifications" item in `ROADMAP.md`).

## What Changes

- New opt-in setting `ntfy.photos` (env `NTFY_PHOTOS=1`), off by default. When on, the
  Notifications for the events `finished`, `failed`, `stopped`, and `paused` carry a
  Photo: one JPEG from the printer's camera, taken the moment the Event is detected.
  `started`, `offline`, and `online` never carry one. The `events` map still decides
  whether an Event is sent at all.
- The Photo is taken through the existing camera proxy: it reuses the next whole JPEG of
  the open upstream when a viewer is watching, or opens the upstream (with Cmd 386 as
  today), takes one frame, and closes it again when no viewer is attached. The service
  never opens a second camera connection to the printer. The JPEG is sent exactly as
  received.
- A Notification with a Photo is published with `PUT <url>/<topic>`: the JPEG as body,
  title, message, priority, and tags in headers (non-ASCII encoded per RFC 2047), file
  name `photo-<event>.jpg`. A Notification without a Photo keeps today's JSON publish.
- The Notification is always delivered: taking the Photo has a hard cap of 5 seconds,
  and a timeout or camera failure sends it text-only. An upload that ntfy answers with a
  4xx status (no attachment cache, size limit) is resent once as text-only JSON with a
  warning in the log. Retries with back-off apply to network errors and 5xx only.
- New opt-in setting `ntfy.photoLight` (env `NTFY_PHOTO_LIGHT=1`), off by default and
  without effect unless `ntfy.photos` is on: when the chamber light is off, the service
  turns it on through the same print-control path and guard as the dashboard's light
  button, waits for a status push showing it on (within the 5 second cap), takes the
  Photo, and turns the light off again unless someone changed it meanwhile
  (`docs/adr/0001-photo-light-automatic-command.md`).
- `pnpm notify:test` attaches a real Photo when photos are on (never sending a light
  command) and reports whether it fell back to text and why.
- Docs: `docs/notifications.md` (settings, delivery, fallback, and a privacy note that a
  Photo of the room goes to the ntfy server, readable on ntfy.sh by anyone with the topic
  or attachment URL until it expires), `README.md` configuration table,
  `docs/deployment.md` env table, `config.example.json`, and `ROADMAP.md`.

Out of scope: a slicer-thumbnail stand-in when the camera is unavailable (text only),
storing Photos in the print history, resizing or re-encoding, and any new dependency.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `print-notifications`: adds Photos to Notifications (opt-in, which events, camera
  source, time cap and text-only fallback, attachment upload and its 4xx fallback, the
  opt-in Photo light, and the test notification), and narrows the delivery retry rule for
  uploads to network errors and 5xx.

## Impact

- Code: `src/config.ts` (two settings), `src/camera-proxy.ts` (take one frame through the
  shared upstream), a new `src/notification-photo.ts` (time cap and Photo light),
  `src/notifier.ts` (attachment upload and fallback), `src/print-control.ts` (light
  command counter for "changed meanwhile"), `src/service.ts` and `src/main.ts` (wiring),
  `scripts/send-test-notification.ts`.
- Tests and fakes: `test/support/fake-ntfy.ts` records binary bodies and headers of
  `PUT` uploads; new and extended tests in `test/camera-proxy.test.ts`,
  `test/notifier.test.ts`, `test/config.test.ts`, `test/service.test.ts`, and a new
  `test/notification-photo.test.ts`.
- Printer: no new SDCP command. The only automatic command is the light (Cmd 403), and
  only with `ntfy.photoLight` on; its request and `Ack` are *static-only* in
  `docs/sdcp-protocol.md`, its effect *observed*.
- ntfy: uses attachments, which ntfy.sh supports and a self-hosted server supports only
  with an attachment cache; without one the text-only fallback applies.
- No HTTP API change (`docs/api.md` unchanged), no new dependency.
