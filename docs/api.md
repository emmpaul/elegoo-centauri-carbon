# HTTP API

The service serves a small HTTP API for the dashboard and for scripts, and
the dashboard itself at `/`. It listens on `listen.host`:`listen.port` from the config (`0.0.0.0:8080` by
default; `config.example.json` uses `127.0.0.1`). A non-loopback listen address
requires a token: see [Access token](#access-token). Don't expose it to the
internet: anyone who can reach it can pause or stop prints.

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | `/api/status` | The current status snapshot, as JSON |
| `GET` | `/api/events` | A Server-Sent Events stream of status snapshots |
| `POST` | `/api/command` | Runs pause, resume, stop, or the light, and reports the result |
| `GET` | `/camera` | The printer's camera as an MJPEG stream (`multipart/x-mixed-replace`) |

The examples below use these two shell variables. Leave `TOKEN` empty if no
access token is configured; the token parts of the examples are then ignored.

```sh
BASE=http://127.0.0.1:8080
TOKEN=change-me
```

## Access token

A non-loopback listen address requires a token. When `listen.host` (or
`LISTEN_HOST`) is anything but `localhost`, `::1`, or an address in
`127.0.0.0/8` (so `0.0.0.0`, `::`, a LAN address, or a host name) and no
token is set (a whitespace-only token counts as none), the service refuses
to start: it prints a message naming the
address, `token` / `ACCESS_TOKEN`, and `listen.host` / `LISTEN_HOST`, and
exits with status 1 before it contacts the printer or opens the port. An
install that listened on `0.0.0.0` without a token must set a token, or
listen on `127.0.0.1`, to start again.

When `token` is set in the config (or `ACCESS_TOKEN` in the environment),
every API and camera route needs it, in one of two forms:

- the header `Authorization: Bearer <token>`, or
- the query parameter `?token=<token>`, for clients that can't set headers,
  such as `EventSource` and `<img>`.

A request without the right token gets `401` with
`{"error":{"code":"unauthorized",...}}` and reaches nothing, the printer
included. The dashboard's own files (see [Dashboard](#dashboard)) hold no
printer data and are served without the token.

```sh
curl -s -i "$BASE/api/status" | head -n 1
# HTTP/1.1 401 Unauthorized
```

## Status snapshot

`GET /api/status` returns the latest snapshot.

```sh
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/status"
```

```json
{
  "connection": "online",
  "printerName": "Centauri Carbon",
  "machineState": { "name": "printing", "code": 1 },
  "printState": { "name": "printing", "code": 13 },
  "taskId": "9f0f4d7e-826e-45df-998e-ea24f6815410",
  "fileName": "test-print-5.gcode",
  "progress": 0,
  "layer": { "current": 5, "total": 640 },
  "elapsed": 240,
  "remaining": 12579,
  "temperatures": {
    "nozzle": { "current": 210.1, "target": 210 },
    "bed": { "current": 59.9, "target": 60 },
    "chamber": { "current": 30.5, "target": 0 }
  },
  "light": "on",
  "errorCode": null,
  "updatedAt": 1794608894794
}
```

| Field | Meaning |
| --- | --- |
| `connection` | `connecting`, `online`, or `offline`. When it isn't `online`, the other values are the last ones received |
| `printerName` | The printer's name from its attributes; `null` until they arrive |
| `machineState`, `printState` | A named state plus the raw protocol code. A code the protocol reference doesn't list has the name `unknown` (see `docs/sdcp-protocol.md`) |
| `taskId`, `fileName` | Current or last job; `null` when the printer reports none |
| `progress` | Percent, 0 to 100 |
| `layer` | Current and total layer |
| `elapsed`, `remaining` | Seconds |
| `temperatures` | °C, current and target, for nozzle, bed, and chamber |
| `light` | Chamber light: `on`, `off`, or `unknown` |
| `errorCode` | Raw error code of the current or last job (0 is no error); `null` until known |
| `updatedAt` | When the last status message arrived, in ms since the epoch; `null` before the first |

Any value can be `null` when the printer hasn't reported it.

## Live updates

`GET /api/events` is a Server-Sent Events stream. It sends the current snapshot
at once, then a new one each time the snapshot changes. Each message has the
event name `status` and the snapshot as JSON in `data`. A comment line
(`: keep-alive`) is sent every 15 seconds. At most 32 streams are served at
once; another answers `503` with `too-many-clients`. A client that stops
reading is disconnected once about 1 MiB is waiting to be sent to it.

```sh
curl -s -N --max-time 3 "$BASE/api/events?token=$TOKEN"
```

```text
event: status
data: {"connection":"online","machineState":{"name":"printing","code":1},...}

```

In a browser:

```js
const events = new EventSource(`/api/events?token=${token}`);
events.addEventListener("status", (e) => render(JSON.parse(e.data)));
```

## Commands

`POST /api/command` takes a JSON body (`Content-Type: application/json`):

| Body | Command | Allowed when |
| --- | --- | --- |
| `{"action":"pause"}` | Pause the print | A print is preparing, checking its file, or printing |
| `{"action":"resume"}` | Resume the print | The print is paused |
| `{"action":"stop","confirm":true}` | Stop the print | A print is preparing, checking its file, printing, or paused. `confirm` must be `true` |
| `{"action":"light","on":false}` | Turn the chamber light off (`true` turns it on) | The light state is known |

Nothing is allowed while the printer is not `online`.

When the command is sent, the answer is `200` with its result. `outcome` is
one of:

- `acknowledged`: the printer accepted it.
- `failed`: the printer refused it; `code` is the printer's code (`null` when
  the response had none).
- `timeout`: no response within 10 seconds.

The snapshot (and the event stream) shows the effect once the printer reports
it.

```sh
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"action":"pause"}' "$BASE/api/command"
# {"action":"pause","outcome":"acknowledged"}
```

```sh
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"action":"light","on":false}' "$BASE/api/command"
# {"action":"light","outcome":"acknowledged"}
```

```sh
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"action":"stop","confirm":true}' "$BASE/api/command"
# {"action":"stop","outcome":"acknowledged"}
```

A command that isn't sent gets an error status and sends nothing to the
printer. For example, resume while the print is running:

```sh
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"action":"resume"}' "$BASE/api/command"
# {"error":{"code":"not-allowed","message":"resume is not allowed in the current state"}}
```

and stop without the confirmation flag:

```sh
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"action":"stop"}' "$BASE/api/command"
# {"error":{"code":"confirmation-required","message":"stop requires explicit confirmation"}}
```

## Camera

`GET /camera` streams the printer's camera as MJPEG, ready for an `<img>`:

```html
<img src="/camera?token=change-me" alt="Printer camera">
```

The service keeps a single connection to the printer's camera, opened with the
first viewer and closed when the last one leaves. When the camera can't be
reached, or doesn't answer within 10 seconds, the answer is `502` with
`{"error":{"code":"camera-unavailable",...}}`.

```sh
curl -s --max-time 2 -o camera.mjpeg "$BASE/camera?token=$TOKEN"; head -c 120 camera.mjpeg
```

## Errors

Errors have the body `{"error":{"code":"<code>","message":"<text>"}}`:

| Status | `code` | When |
| --- | --- | --- |
| 400 | `bad-request` | The request target isn't a valid URL, the body isn't a JSON object, the action is unknown, `on` is missing for the light, or the body is over 4 KiB |
| 400 | `confirmation-required` | Stop without `"confirm": true` |
| 401 | `unauthorized` | Missing or wrong token |
| 404 | `not-found` | Unknown path |
| 405 | `method-not-allowed` | Wrong method; the `Allow` header lists the right one |
| 409 | `not-allowed` | The command doesn't fit the current print state, or the printer isn't online |
| 502 | `camera-unavailable` | The camera can't be reached or doesn't answer within 10 seconds |
| 503 | `not-connected` | The printer session closed before the command was answered |
| 503 | `too-many-clients` | 32 event streams are already open |
| 500 | `internal` | Anything else (details go to the service log) |

## Dashboard

`GET /` serves the dashboard, a page that reads `/api/status`, then follows
`/api/events` and updates without a reload. It reads `/camera` with `fetch`
and shows "Camera unavailable" with a retry button when the stream can't be
opened, ends, or sends no frame for 10 seconds (it tries again every 10
seconds). While the printer is offline it closes the stream and shows
"Camera offline", and opens the stream again when the printer is back. Its pause, resume, stop, and light buttons are enabled by the same
rules `POST /api/command` applies (`src/control-rules.ts`). Stop is a slide:
it sends `{"action":"stop","confirm":true}` only once the thumb is dragged to
the end of the track (or moved there with four presses of →), and an early
release sends nothing. Each command's result (pending, acknowledged, failed
with its code, or timed out) is shown in a message line above the buttons.

Its files are `/`, `/app.js`, `/theme.js`, `/view.js`, `/stop-slide.js`, `/mjpeg.js`, `/src/control-rules.ts`,
`/style.css`, `/sw.js` (the service worker), `/manifest.webmanifest`, the
icons under `/icons/`, and the fonts `/fonts/satoshi-{400,500,700}.woff2` and
`/fonts/cabinet-grotesk-800.woff2`. The fonts are optional: they are served
once fetched with `pnpm fonts:fetch` and answer `404` otherwise. The scripts are the TypeScript sources in `web/` (and
`src/control-rules.ts`) with their types stripped when served. They are
served without the token, on `GET` and `HEAD`.

The page works at phone width (360 px) and can be installed as a web app.
Browsers install a web app, and run its service worker, only from a secure
origin: HTTPS, or `localhost`/`127.0.0.1` on the same machine. Opened as
`http://<LAN address>:8080` on a phone, the page works but Chrome on Android
won't offer to install it; Safari on iOS can still add it with Share → Add to
Home Screen. To get the install prompt on Android, serve the dashboard over
HTTPS, for example through `tailscale serve` or a reverse proxy with a
certificate.

When the service has a token, open the dashboard once as
`http://<host>:8080/?token=<token>`, or enter the token in the form the page
shows. The page keeps the token in the browser's local storage and sends it
with every API request.

## Trying it without the printer

`pnpm start:fake` runs the service on `127.0.0.1:8080` against a fake printer
and a fake camera, with a print running. `LISTEN_PORT` and `ACCESS_TOKEN` set
the port and the token:

```sh
ACCESS_TOKEN=change-me pnpm start:fake
```

The fake printer simulates the print: progress, layers, and times advance
(`FAKE_SPEED` print seconds per second, 10 by default) until the job
completes. Pause, resume, stop, and the light change its state as the printer
would. To try failures:

- `FAKE_CAMERA=down` starts with the camera answering `503`.
- `FAKE_REPLIES` sets per-command replies by command id (see
  `docs/sdcp-protocol.md`): `silent` sends no response, so the command times
  out after 10 seconds, and a number answers with that `Ack`, so it fails with
  that code. For example, resume times out and the light fails with code 3:

  ```sh
  FAKE_REPLIES=131=silent,403=3 pnpm start:fake
  ```

- `SIGUSR1` takes the camera down (open streams end, new ones get `503`) and
  back up; `SIGUSR2` takes the fake printer offline and back:

  ```sh
  pkill -USR1 -f run-fake-service
  pkill -USR2 -f run-fake-service
  ```
