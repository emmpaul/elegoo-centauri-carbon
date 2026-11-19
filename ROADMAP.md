# Roadmap

Ideas for where this project goes next, roughly in the order they are likely to land.
Nothing here is promised or scheduled. Each item becomes an OpenSpec change under
`openspec/changes/` before any code is written, and the specs in `openspec/specs/`
describe what the service does today.

The printer's protocol is reverse-engineered, so every item depends on how well its
commands are known. [docs/sdcp-protocol.md](docs/sdcp-protocol.md) labels each one:

- **observed**: seen working on a real printer, with a recorded frame.
- **static-only**: read from the printer's web UI code, never confirmed on the wire.

Items that need only observed commands, or none, come first. Items that need static-only
commands wait for a live capture, and anything that moves the printer or starts a print
gets the same per-state guards and confirmation as stop does today.

## Next

### Camera snapshot in notifications

Attach a frame from the camera to the "print finished" and "print failed" ntfy
notifications, so a phone shows a clean part or a failed print without opening the
dashboard. ntfy supports attachments, and the service already proxies the camera.
**Protocol:** none needed.

### Progress notifications

Optional notifications at useful points in a print: when the first layer is done (when
most prints fail) and when about ten minutes are left. They come from the status the
service already reads, and the same event dedupe applies.
**Protocol:** none needed.

## Later

### Temperature and progress charts

Keep a few hours of status in memory and draw nozzle, bed, and chamber temperature
sparklines on the dashboard. Optionally expose a `/metrics` endpoint for Prometheus and
Grafana. **Protocol:** none needed.

### Home Assistant

Publish status and events over MQTT with Home Assistant discovery, so the printer shows
up as entities (state, progress, temperatures, light) that automations can use.
**Protocol:** none for status; the light uses the existing guarded command.

### Power-loss alert

Notify when the printer reports an unfinished print after a power loss. At first this
only notifies; resuming or discarding the print from the dashboard comes later.
**Protocol:** Cmd 134 (check) *observed*; Cmd 135 (resume or discard) *static-only*.

### Files on the printer

List the files stored on the printer, with layer count, layer height, and estimated
filament. Starting a print from the list is a separate, later step.
**Protocol:** Cmd 258 (file list) *observed*; Cmd 260 (file detail) *static-only*;
Cmd 128 (start print) *static-only*.

## Needs a live capture first

### Print speed, fans, and target temperatures

Speed modes (50, 100, 130, 160 %), fan speeds, and nozzle and bed targets. They all use
Cmd 403, the command the chamber light already uses. Only the light payload has been
confirmed. **Protocol:** Cmd 403 speed, fan, and temperature payloads, *static-only*.

### Time-lapse download

Link the time-lapse video of a finished job from the history view.
**Protocol:** `TimeLapseVideoUrl` in the Cmd 321 answer (field *observed*, never fetched);
Cmd 323 *static-only*.

## Ideas

- More notification targets (Discord, Telegram, email), for example through Apprise.
- Several printers in one service and one dashboard.

## Suggesting something

Open an issue describing what you want to do with the printer. A capture of the web UI
doing it (see [docs/sdcp-protocol.md](docs/sdcp-protocol.md)) moves an idea from
static-only to observed. Redact captures before you share them: MAC address, LAN
address, and file names.
