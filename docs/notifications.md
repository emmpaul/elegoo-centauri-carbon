# Notifications

The service can push a notification to your phone when a print starts,
finishes, fails, pauses, or stops, and when the printer goes offline or comes
back. It sends them through [ntfy](https://ntfy.sh), a free publish/subscribe
push service: the service publishes to a *topic*, and the ntfy app on your
phone subscribes to the same topic. No account is needed.

Notifications are off until you configure a topic.

## 1. Install the ntfy app

- Android: "ntfy" on Google Play or F-Droid.
- iPhone: "ntfy" on the App Store.

Open the app and allow notifications when it asks.

## 2. Choose a topic

On ntfy.sh, a topic is created the first time something publishes to it or
subscribes to it, and **anyone who knows its name can read and send its
messages**. The topic name is the only protection, so treat it like a
password:

- Make it long and random. Generate one with
  `node -e "console.log('printer-' + crypto.randomBytes(12).toString('hex'))"`,
  which prints something like `printer-3f9c2a7be41d08c5a6e2f913`.
- Don't use the placeholder from `config.example.json`
  (`change-me-to-a-hard-to-guess-topic`), or a guessable name such as
  `centauri` or your name.

If you'd rather not use the public server at all, run your own (see
[Self-hosting](#self-hosting)).

## 3. Subscribe on your phone

In the ntfy app, tap **+** (Subscribe to topic), enter the topic name, and
keep the server as `ntfy.sh` (or pick "Use another server" for a self-hosted
one). Subscribe.

## 4. Configure the service

Set the ntfy server and topic in `config.json` (copy `config.example.json` to
start):

```json
{
  "ntfy": {
    "url": "https://ntfy.sh",
    "topic": "printer-3f9c2a7be41d08c5a6e2f913",
    "photos": false,
    "photoLight": false
  },
  "events": {
    "started": true,
    "finished": true,
    "failed": true,
    "paused": true,
    "stopped": true,
    "offline": true,
    "online": true
  }
}
```

- `ntfy.url`: the ntfy server; `https://ntfy.sh` by default.
- `ntfy.topic`: your topic. `null` (the default when the file doesn't set it)
  turns notifications off.
- `ntfy.photos`: attach a Photo from the camera to the finished, failed,
  stopped, and paused notifications (see [Photos](#photos)). `false` by
  default.
- `ntfy.photoLight`: turn the chamber light on for the Photo (see
  [The Photo light](#the-photo-light)). `false` by default, and no effect
  without `ntfy.photos`.
- `events`: turn each kind of notification on (`true`) or off (`false`).
  All are on by default.

Environment variables override the file: `NTFY_URL`, `NTFY_TOPIC`,
`NTFY_PHOTOS`, `NTFY_PHOTO_LIGHT` (`1` or `true` turn them on, `0` or
`false` off), and `NOTIFY_EVENTS`, a comma-separated list of the events to send (every event
not listed is turned off; `none` turns them all off), for example
`NOTIFY_EVENTS=finished,failed,offline`.

On start the service logs `notifications to <url>`, followed by
` (with photos)` or ` (with photos and the photo light)` when those are on,
or `notifications off (no ntfy topic)`.

## 5. Send a test notification

With the topic configured, run this from the repository:

```sh
pnpm notify:test
```

It sends one "Test notification" through the configured server and topic,
exactly as the service sends print events (with the same retries), and
prints `Test notification sent to <url>, topic <topic>.` Your phone should
show it within a few seconds. It exits with status 1 and logs the reason
when no topic is configured or the server can't be reached. With photos off
it doesn't contact the printer.

With photos on (see [Photos](#photos)) it finds the printer (`printerIp`,
else discovery), waits up to 5 seconds for it to answer, and attaches a
real Photo from its camera, uploaded as `photo-test.jpg`. It never sends a
light command, even with the Photo light on. It then prints
`Test notification sent to <url>, topic <topic>, with a photo.`, or, when it
fell back to text,
`Test notification sent to <url>, topic <topic>, without a photo: <reason>.`
(for example `printer not online within 5 s`, or the camera error). A
fallback still exits with status 0: the notification was delivered. The
command opens its own camera connection, so run it while the service is
stopped or nobody watches the camera, if the printer refuses a second
stream.

You can also test the topic alone, without the service, with curl:

```sh
curl -d "Hello from the printer" https://ntfy.sh/printer-3f9c2a7be41d08c5a6e2f913
```

## What you get

| Event | When | Message |
| --- | --- | --- |
| `started` | A new print starts | `<file> started.` |
| `finished` | A print completes | `<file> finished in <duration>.` |
| `failed` | A print ends with an error code from the printer | `<file> failed at <progress>% (error code <code>).` (high priority) |
| `paused` | A print is paused (each pause) | `<file> paused at <progress>%.` |
| `stopped` | A print is stopped | `<file> stopped at <progress>%.` |
| `offline` | The printer has been unreachable for 2 minutes in a row | `<printer> has been unreachable for 2 minutes.` (high priority) |
| `online` | The printer is reachable again after an `offline` notification | `<printer> is reachable again.` |

Notes:

- Each event is sent once. Repeated status messages and reconnects don't
  repeat it, and a network blip shorter than 2 minutes sends nothing.
- The duration is the print time the printer counts (the elapsed time the
  dashboard shows), not the wall-clock time from start to finish.
- When the service starts in the middle of a print, it doesn't announce that
  print as started; it does report how it ends.
- The error code in `failed` is the printer's raw `ErrorStatusReason`. Elegoo
  documents only code 45 ("Consumables are about to run out"); see
  `docs/sdcp-protocol.md`, "Error codes".
- If ntfy can't be reached, the service retries 3 times (after 1, 2, and
  4 seconds), then logs `ntfy: gave up on <event> ...` and drops that
  notification. Monitoring the printer carries on unaffected. A Photo upload
  is retried this way only on a network error or a 5xx answer; a 4xx answer
  falls back to text at once (see [Photos](#photos)).

## Photos

The service can attach a Photo, one still from the printer's camera, to the
`finished`, `failed`, `stopped`, and `paused` notifications, so you see the
print without opening the dashboard. `started`, `offline`, and `online`
never carry one. Photos are off by default; one setting turns them on for
all four events, and `events` still decides whether an event is sent at all:

```json
{ "ntfy": { "url": "https://ntfy.sh", "topic": "printer-3f9c2a7be41d08c5a6e2f913", "photos": true } }
```

or the environment variable `NTFY_PHOTOS=1` (`1` or `true` turn it on, `0`
or `false` off, and it overrides the file).

How it works:

- The Photo is the next whole frame of the camera when the event is
  detected. If the dashboard is showing the camera, the service takes it
  from that same connection; otherwise it opens the camera as it does for a
  viewer and closes it again afterwards. The JPEG is sent exactly as the
  camera sent it.
- Taking the Photo is capped at 5 seconds from the event. When no frame
  arrives in time, or the camera can't be reached, the notification goes out
  text-only and the service logs `ntfy: <event> sent without a photo:
  <reason>` (for example `photo timed out`). A notification is never lost
  because of the camera.
- A notification with a Photo is published as an ntfy attachment upload: a
  `PUT` to the topic with the JPEG as the body, the title, message, priority,
  and tags in headers, and the file name `photo-<event>.jpg`. Non-ASCII text
  in those headers (a file name with accents, say) is sent RFC 2047 encoded,
  and ntfy shows it unchanged.
- When ntfy refuses the upload with a 4xx answer, the service logs
  `ntfy: photo upload for <event> rejected (HTTP <status>); sending text only`
  and sends the same notification once without the Photo. It doesn't retry
  the upload. Common causes:
  - A self-hosted server without attachments: set `attachment-cache-dir` in
    its `server.yml` (see the
    [ntfy attachment docs](https://docs.ntfy.sh/config/#attachments)).
  - ntfy.sh limits: it caps the size of each attachment and the total a
    client may upload, and deletes attachments after a few hours (see
    [ntfy.sh limits](https://docs.ntfy.sh/publish/#attachments)).
- A network error or a 5xx answer is retried after 1, 2, and 4 seconds like
  any notification, then given up with `ntfy: gave up on <event> ...`, with
  no text-only fallback (the server is down, so text would fail the same
  way).

### The Photo light

The chamber light is often off when a print ends, and a Photo of a dark
chamber shows little. With `ntfy.photoLight` (or `NTFY_PHOTO_LIGHT=1`) the
service turns the light on for the Photo:

- It's off by default, and has no effect unless `ntfy.photos` is on.
- It acts only when the printer reports the light off. When the light is
  already on, or its state isn't known yet, no light command is sent.
- The command goes through the same checks as the dashboard's light button:
  when they refuse it (the printer is offline, or hasn't reported its light
  yet), the Photo is taken with the light as it is.
- After the command the service waits for a status push showing the light
  on, up to 3 seconds, then takes the Photo anyway; the 5-second limit
  still holds.
- After the Photo it turns the light off again, unless someone changed it
  meanwhile: a light command from the dashboard, or the printer reporting
  the light off after it came on. It doesn't wait for a report showing the
  light on before turning it off.

This is the one command the service sends to the printer on its own,
without a person pressing a button; see
[ADR 0001](adr/0001-photo-light-automatic-command.md) for why it is allowed
and how it is bounded. The light comes on briefly during a pause too, while
a print is still in progress.

### Privacy

A Photo shows the inside of the printer and whatever of the room
the camera sees, and it is uploaded to the ntfy server. On ntfy.sh anyone
who knows the topic, or the attachment's URL, can see it until it expires.
Use a long random topic (see [Choose a topic](#2-choose-a-topic)) or a
self-hosted server if that matters to you.

## Self-hosting

ntfy is open source and runs anywhere Docker does, including the Raspberry Pi
that runs this service:

```sh
docker run -d --name ntfy -p 8090:80 -v ntfy-cache:/var/cache/ntfy \
  binwiederhier/ntfy serve --cache-file /var/cache/ntfy/cache.db
```

Then point the service at it, using an address your phone can also reach:

```json
{ "ntfy": { "url": "http://192.168.0.10:8090", "topic": "printer" } }
```

and in the ntfy app subscribe with "Use another server" set to the same
address. See the [ntfy self-hosting docs](https://docs.ntfy.sh/install/) for
installing without Docker, and for configuration.

Things to know:

- The service publishes without credentials, so the topic must accept
  anonymous publishing. If you turn on ntfy's access control, allow
  anonymous write access to the printer's topic.
- iPhones only get instant notifications from a self-hosted server when it
  forwards to ntfy.sh: set `upstream-base-url: "https://ntfy.sh"` in the
  server's `server.yml`. Android works without it.
- A server reachable only on your home network delivers only while your phone
  is on that network (or on a VPN into it, such as Tailscale).
