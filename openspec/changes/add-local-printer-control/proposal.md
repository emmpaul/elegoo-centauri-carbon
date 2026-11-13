# Proposal

## Why

Elegoo's tools are the only way to control or watch the Centauri Carbon: the
printer's built-in web page, ElegooSlicer, and the cloud-backed phone app. None
of them send a push notification on the LAN when a print finishes or fails.
None offers a phone-friendly view that works without the cloud. The printer
already speaks a local protocol (SDCP V3.0.0 on firmware V1.4.49, confirmed by a
UDP discovery reply from 192.168.0.96), but Elegoo doesn't document it. So we
first map the protocol with REA, then build a small local-first app on it.

## What Changes

- **Protocol mapping (REA phase):** reverse-engineer the SDCP messages the
  printer's own web UI uses (`main.*.js` bundle served at
  `http://192.168.0.96/`). Confirm them against live WebSocket traffic, and
  optionally against a capture of ElegooSlicer traffic. Output: a written
  protocol reference (`docs/sdcp-protocol.md`) and recorded message fixtures
  used by the tests.
- **New LAN service:** a long-running process. It discovers the printer, keeps
  one SDCP WebSocket session open, keeps an up-to-date status model, and
  exposes a small HTTP/WebSocket API to the dashboard.
- **New dashboard:** a phone-friendly web app (installable as a PWA) served by
  the service. It shows live status, progress, temperatures, the current file,
  and the camera stream. It has pause, resume, and stop controls; stop requires
  confirmation.
- **New notifications:** push messages when a print finishes, fails or errors,
  is paused, or when the printer goes offline. Delivery is through ntfy by
  default, behind a small pluggable channel interface.
- Out of scope: camera-based failure detection, starting prints, uploading
  files, firmware modification, and Elegoo cloud APIs.

## Capabilities

### New Capabilities
- `printer-connection`: discover the printer, keep the SDCP session open,
  reconnect, and keep a normalized live status model.
- `print-control`: send pause, resume, and stop commands (plus the chamber
  light toggle) and report whether each command succeeded.
- `printer-dashboard`: phone-friendly web UI with live status, camera view, and
  control buttons.
- `print-notifications`: detect print lifecycle events and deliver push
  notifications.

### Modified Capabilities
<!-- None: the project has no existing specs. -->

## Impact

- New codebase in this repo: a Node.js 26 + TypeScript service and a static
  dashboard. No existing code is affected.
- Network: talks only to the printer on the LAN (UDP 3000, WS 3030, HTTP 3031
  for the camera) and to the configured notification endpoint (ntfy.sh, or a
  self-hosted ntfy).
- Security: SDCP has no authentication. Anyone who can reach this service can
  pause or stop prints, so the service binds to the LAN only and supports an
  optional access token.
- New dependencies (expected): a WebSocket client/server library, a test
  runner, and nothing heavy.
