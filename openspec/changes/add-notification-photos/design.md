# Design

## Context

See `proposal.md` for the why and `specs/print-notifications/spec.md` for the required
behavior. Terms follow `GLOSSARY.md`: a **Photo** is the camera still attached to a
**Notification**; "snapshot" means only `StatusSnapshot`. The automatic light command is
recorded in `docs/adr/0001-photo-light-automatic-command.md`.

What exists today:

- `src/notifier.ts`: `NtfyNotifier.notify(event)` skips disabled events, then
  `publish()` POSTs JSON to the server root, retrying every failure (HTTP status or
  network) after 1, 2, and 4 s, with a 10 s timeout per request. `notify()` never rejects.
- `src/camera-proxy.ts` (design D5 of the original change): one upstream MJPEG
  connection, opened with the first viewer (after `beforeConnect`, Cmd 386) and closed
  when the last viewer leaves. It splits nothing: it forwards bytes and only finds the
  part delimiter (`delimiterOf`) so a late viewer starts at a part boundary.
- `src/service.ts`: the notifier is built in `src/main.ts` from the config and handed to
  `startService`, which creates the store, detector, `PrintControl`, and `CameraProxy`,
  and calls `notifier.notify(event)` fire-and-forget on each detector event.
- `src/print-control.ts` / `src/control-rules.ts`: `setLight(on)` sends Cmd 403 with the
  last `LightStatus`, refused (`ControlRejectedError`) unless online and `LightStatus` is
  known. The snapshot's `light` is `"on" | "off" | "unknown"`.
- `scripts/send-test-notification.ts`: `pnpm notify:test`, which never contacts the
  printer today.

## Goals / Non-Goals

**Goals:**

- Attach a Photo without a second camera connection, a new dependency, or any change to
  the bytes the camera sends.
- Bound the delay a Photo adds to a Notification (5 s), and never lose a Notification
  because of the camera or ntfy's attachment support.
- Keep the Photo light inside the existing command guard, and leave the light as the
  owner had it.

**Non-Goals:**

- Photos for `started`, `offline`, `online`; slicer thumbnails as a stand-in; Photos in
  the print history; resize or re-encode; a Photo in the HTTP API (`docs/api.md` does
  not change); Photos in `pnpm start:fake` (the fake service has no notifier).

## Decisions

### D1. Settings

`Config.ntfy` gains `photos: boolean` and `photoLight: boolean`, both `false` by
default. File keys `ntfy.photos` and `ntfy.photoLight` must be booleans (otherwise an
error naming the key, as for `events`). Env `NTFY_PHOTOS` and `NTFY_PHOTO_LIGHT` win over
the file: `1` or `true` turn on, `0` or `false` turn off, empty counts as unset, anything
else is an error naming the variable. `photoLight` without `photos` is accepted and has
no effect (no warning: the docs say so). `src/main.ts` logs
`notifications to <url> (with photos)` or `(with photos and the photo light)`.

*Alternative:* a per-event photo map. Rejected by the settled decision: one switch for
the four events; the `events` map already decides what is sent.

### D2. One frame from the shared upstream: `CameraProxy.takeFrame()`

`takeFrame(options: { signal: AbortSignal; after?: Promise<unknown> }): Promise<Buffer>`
adds a *frame taker* next to the viewers:

- When neither a viewer nor a taker holds the upstream, it opens it exactly as for a
  viewer (`connect()`, so `beforeConnect` sends Cmd 386). The upstream now closes when
  the last viewer **and** the last taker are gone, and `upstreamOpen` /
  `upstreamConnections` keep their meaning, so the existing tests still hold.
- A taker is *armed* once `after` resolves (immediately without `after`). It collects
  the first part whose delimiter arrives after arming, up to the next delimiter: skip
  the part headers (up to `\r\n\r\n`), drop the trailing `\r\n` before the next
  delimiter, and resolve with those bytes unchanged. "Next whole JPEG" therefore holds
  both for a watched stream and for a fresh one.
- It rejects (and detaches) when: `signal` aborts (`"photo timed out"`), the upstream
  fails (the same reason `fail()` logs; viewers still get their 502), the stream has no
  multipart boundary, the part does not start with the JPEG SOI marker `FF D8`, or the
  part grows past 8 MiB.
- A taker never counts as a viewer (`viewerCount` unchanged), so dashboard behavior and
  backlog rules are untouched. Parsing runs only while a taker is waiting.

Part bodies are cut at delimiters rather than read by `Content-Length`, because the
proxy already relies on the delimiter and the real camera's part headers are not
documented; the fake camera sends `Content-Length`, which the parser simply skips.

*Alternative:* a separate `http.get` to the camera per Photo. Rejected: the printer would
serve two streams while a viewer watches (design D5 forbids it).

### D3. Taking a Photo: `src/notification-photo.ts`

`PHOTO_EVENTS = new Set(["finished", "failed", "stopped", "paused"])`, and a
`PhotoTaker` built from `{ camera: { takeFrame }, light: { state, control } | null,
limitMs = 5000, lightWaitMs = 3000, logger }` with
`take(): Promise<PhotoResult>`, where
`PhotoResult = { jpeg: Buffer } | { jpeg: null; reason: string }`. It never rejects.

- The cap is one `AbortSignal.timeout(limitMs)` created when the take starts; it is the
  `signal` of `takeFrame`, so the whole take (light wait included) ends within 5 s.
- Takes run one at a time (a promise chain), so two Events in quick succession never
  fight over the light; each take's cap starts when it starts. Events close enough to
  queue are rare (a pause right before a stop), and the second waits at most 5 s.
- Without the light (`light` null, or the light not `"off"`): `takeFrame({ signal })`.

### D4. The Photo light

Only when `photoLight` is on and `snapshot.light === "off"`:

1. Remember `PrintControl.lightCommands` (a new counter incremented each time a light
   command passes the guard and is sent, by anyone: the dashboard's `POST
   /api/command` and the Photo light go through the same `setLight`).
2. Call `control.setLight(true)` without awaiting its 10 s response. A
   `ControlRejectedError` (offline, `LightStatus` unknown) means no command was sent:
   the Photo is taken as it is. Any other rejection or a `failed`/`timeout` outcome is
   logged; the wait below still decides.
3. `takeFrame({ signal, after })` starts at once, so the camera opens in parallel; `after`
   resolves on the first store `change` whose snapshot shows `light: "on"`, or after
   `lightWaitMs` (3 s) without one, which leaves at least 2 s of the cap for a frame. No
   confirmation: the Photo is taken anyway.
4. Restore in `finally` (after the Photo or its failure), without delaying the
   Notification: send `setLight(false)` only if `lightCommands` is still the value right
   after our command (no one else sent a light command), no store change showed the
   light `"off"` after it showed `"on"`, and the snapshot shows `"on"` now. A refusal or
   failure of that command is logged as a warning.

`light.state` reads `store.snapshot.light`; `light.control` is the service's
`PrintControl`, so the guard in `control-rules.ts` applies unchanged. No other command is
ever sent for a Photo.

*Alternatives:* awaiting the Cmd 403 `Ack` (static-only, up to 10 s, exceeds the cap);
leaving the light on (rejected in the ADR).

### D5. Delivery: `NtfyNotifier`

- `Notifier.notify(event, photo?: () => Promise<PhotoResult>)`. `notify` checks
  `events[type]` first and only then calls `photo()`, so a disabled event never touches
  the camera or the light. A result without a JPEG logs
  `ntfy: <event> sent without a photo: <reason>` (info) and publishes text-only.
- New `deliver(push, label, photo?: PhotoResult): Promise<Delivery>` with
  `Delivery = { delivered: boolean; photo: boolean; fallback: string | null }`;
  `notify` and the test command use it, and `publish()` stays the text-only JSON path
  (unchanged, retrying every failure as today).
- Upload: `PUT <url>/<encodeURIComponent(topic)>`, body the JPEG, headers `Title`,
  `Message`, `Priority`, `Tags` (comma-joined), `Filename: photo-<event>.jpg`,
  `Content-Type: image/jpeg`. A header value with any character outside printable ASCII
  is sent as one RFC 2047 encoded word, `=?UTF-8?B?<base64>?=`, which ntfy decodes.
  The test command uses `photo-test.jpg`.
- Upload outcome: 2xx delivered with photo. 4xx: no retry, warn
  `ntfy: photo upload for <label> rejected (HTTP <status>); sending text only`, then
  `publish()` once (with its usual retries); `fallback` names the status. Network error
  or 5xx: retry after 1, 2, 4 s like `publish()`, then log the give-up and resolve
  undelivered (no text fallback: the server or network is down, a JSON publish would
  fail the same way).

*Alternative:* a JSON publish with an `attach` URL pointing at this service. Rejected:
the service is usually not reachable from the phone or ntfy.sh, and it would expose the
camera.

### D6. Wiring

`ServiceOptions.photos?: { light: boolean } | null` (null by default). When set,
`startService` builds one `PhotoTaker` from the `CameraProxy`, the `StatusStore`, and the
`PrintControl` (light only when `light` is true) and calls
`notifier.notify(event, PHOTO_EVENTS.has(event.type) ? () => photos.take() : undefined)`
in the existing event handler, so the Photo is requested the moment the detector emits.
`src/main.ts` passes `photos: config.ntfy.photos ? { light: config.ntfy.photoLight } :
null`. The `Notifier` interface stays the single seam: tests can pass a fake.

### D7. `pnpm notify:test`

The logic moves to `src/notify-test.ts` (`sendTestNotification({ config, printerUrl?,
cameraUrl?, logger })`, testable against the fakes); the script stays a thin wrapper that
resolves the printer address (`printerIp`, else discovery) only when photos are on.
With photos off it behaves as today and never contacts the printer. With photos on it
opens a `PrinterSession`, waits up to 5 s for it to be online, takes one Photo through a
private `CameraProxy` (with Cmd 386 in `beforeConnect`) and a `PhotoTaker` without light,
closes both, and delivers. It prints
`Test notification sent to <url>, topic <topic>, with a photo.` or
`..., without a photo: <reason>.`, and exits 0 when delivered. A session that does not
come online is a fallback reason, not an error.

### D8. Test fakes

`test/support/fake-ntfy.ts` keeps `body` (UTF-8) and adds `raw: Buffer`, so a test
compares the uploaded bytes with the fake camera's `fakeJpeg(n)`; headers are already
recorded. `statuses` already scripts 4xx and 5xx answers. `FakeMjpegSource` needs no
change (its frames start with `FF D8`); a test that needs a slow camera uses a large
`frameIntervalMs`, and an unreachable one uses a closed port. Light tests use
`FakePrinter` `replies` for Cmd 403 plus `printer.push()` of a status with
`LightStatus.SecondLight` 1, or stub `{ state, control }` objects in unit tests.

## Risks / Trade-offs

- [The real camera's part layout is unconfirmed (headers, trailing CRLF)] → Cut at
  delimiters and check the SOI marker; a malformed part is a logged text-only fallback,
  never a broken Notification. A live check with `pnpm notify:test` is the first step
  after merge.
- [Cmd 403 request and `Ack` are *static-only*; only the effect is *observed*] → The
  Photo light waits for the status push, not the `Ack`, and is opt-in.
- [The light briefly turns on during a print (paused) and may be visible on the
  printer's own camera feed] → Opt-in, restored right after.
- [ntfy.sh attachment limits (size, per-visitor quota, expiry after a few hours) or a
  self-hosted server without `attachment-cache-dir`] → 4xx falls back to text with a
  warning; documented in `docs/notifications.md`.
- [Privacy: the Photo shows the room and goes to a third-party server] → Off by default;
  privacy note in `docs/notifications.md`.
- [`pnpm notify:test` with photos on opens its own camera stream, a second one while the
  service has a viewer] → It is a manual one-off outside the service; a refused stream is
  a reported fallback. The service itself never opens a second connection.
- [A queued second take may wait up to 5 s behind the first] → Rare; bounded.

## Migration Plan

Nothing to migrate: both settings are off by default, so existing installs send exactly
the same JSON Notifications. Rollback is turning `ntfy.photos` off or reverting.
