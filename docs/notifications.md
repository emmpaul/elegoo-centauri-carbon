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
    "topic": "printer-3f9c2a7be41d08c5a6e2f913"
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
- `events`: turn each kind of notification on (`true`) or off (`false`).
  All are on by default.

Environment variables override the file: `NTFY_URL`, `NTFY_TOPIC`, and
`NOTIFY_EVENTS`, a comma-separated list of the events to send (every event
not listed is turned off; `none` turns them all off), for example
`NOTIFY_EVENTS=finished,failed,offline`.

On start the service logs `notifications to <url>`, or
`notifications off (no ntfy topic)`.

## 5. Send a test notification

With the topic configured, run this from the repository:

```sh
pnpm notify:test
```

It sends one "Test notification" through the configured server and topic,
exactly as the service sends print events (with the same retries), and
prints `Test notification sent to <url>, topic <topic>.` Your phone should
show it within a few seconds. It exits with status 1 and logs the reason
when no topic is configured or the server can't be reached. It doesn't
contact the printer.

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
  notification. Monitoring the printer carries on unaffected.

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
