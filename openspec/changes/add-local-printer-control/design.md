# Design

## Context

- Greenfield repo; only OpenSpec scaffolding exists.
- Observed on 2026-11-13 against the user's printer at 192.168.0.96:
  - UDP `M99999` to port 3000 returns JSON with `ProtocolVersion: V3.0.0`,
    `FirmwareVersion: V1.4.49`, and the `MainboardID`.
  - `http://192.168.0.96/` serves the built-in web UI: `runtime.*.js`,
    `polyfills.*.js`, and `main.f1485af82d8237b5b3c1.js`. This looks like an
    Angular build.
  - `http://192.168.0.96:3031/video` serves MJPEG
    (`multipart/x-mixed-replace`).
- Not yet confirmed: the SDCP WebSocket on port 3030, the exact message
  envelope, the command ids, and the status codes. Community notes describe an
  `{Id, Data:{Cmd, Data, RequestID, MainboardID, TimeStamp, From}}` envelope,
  with `sdcp/request|response|status|attributes/<MainboardID>` topics. We treat
  those notes as hypotheses that phase A must confirm.
- Dev machine: WSL2 on Windows. Node 22 is installed via nvm; the user wants
  **Node 26**. No tcpdump or tshark is installed in WSL.

## Goals / Non-Goals

**Goals:**
- A protocol reference that is backed by evidence (bundle code plus observed
  frames) before any client code depends on it.
- One small process with few dependencies that runs on a PC or a Raspberry Pi.
- Tests that run without the printer, using recorded fixtures and a fake
  printer.

**Non-Goals:**
- Supporting printers other than the Centauri Carbon. The protocol client
  shouldn't block that later, but it isn't tested here.
- Multi-user accounts, internet exposure, HTTPS termination. Users who need
  remote access should use a VPN, e.g. Tailscale.

## Decisions

### D1. Protocol mapping is evidence-first, in two passes
1. **Static pass (REA):** download the web UI bundle into its own scratch
   directory, treated as untrusted data. Run REA web-bundle analysis and string
   search on it to find the WebSocket URL, the envelope builder, every `Cmd`
   id, and the code tables for state and errors.
2. **Live pass:** observe the real web UI talking to the printer. Use REA's
   browser capture (`capture_browser_scenario` /
   `inspect_web_network_capture`) to record WebSocket frames while you click
   through the UI. Optionally, capture ElegooSlicer traffic with Wireshark on
   Windows.

Every command in `docs/sdcp-protocol.md` is labeled with how it was confirmed:
*static-only*, *observed*, or *tested*. Recorded frames are saved as fixtures.
Pause, resume, and stop are only exercised during a deliberate small test
print.
*Alternative:* trust community docs alone. Rejected: they can be out of date
for firmware V1.4.49, and stop is destructive.

### D2. Runtime: Node.js 26 + TypeScript, with no build step
Node 26 runs `.ts` files directly through built-in type stripping, so there's
no bundler or `tsc` emit. `tsc --noEmit` is used only for type checking. The
built-in `WebSocket` client and `fetch` cover printer and ntfy traffic. The test
runner is `node:test`.
*Alternatives:* Python (also fine, but the dashboard is TS anyway, so one
language wins). Bun/Deno: the user chose Node.

### D3. Dashboard gets live updates through Server-Sent Events, not WebSocket
The dashboard only needs a push stream from server to browser. Commands are
plain `POST`s. Node's built-in `http` serves SSE natively, so there's no
WebSocket server dependency in production.
*Alternative:* the `ws` package for two-way traffic. Not needed; it stays as a
test-only dependency for the fake printer.

### D4. Single process, small modules connected by an event bus
```
 discovery --> sdcp-client <--> printer (WS :3030)
                   |
                   v
             status-store --(snapshot changes)--> event-detector --> notifier --> ntfy
                   |                                                    
                   v                                                    
   http-server: /api/status (SSE), /api/command (POST), /camera (proxy), static dashboard
```
`status-store` is the single source of truth. Both `event-detector` and SSE
subscribe to it. Event dedupe is keyed on job id (`TaskId` if the protocol
provides one, otherwise filename + start time) plus event type.

### D5. Camera goes through a proxy in the service
The service opens one upstream MJPEG connection and fans it out to the
browsers. Benefits: the page stays same-origin, the access token applies to the
camera too, and the printer never gets several streams at once (its limit on
concurrent clients is unknown).
*Alternative:* the browser connects to `:3031` directly. Simpler, but it
bypasses the token and may hit a client limit.

### D6. Safety rules enforced in one place
Two checks run in the command layer, so neither the dashboard nor future
integrations can bypass them:
- An allow-list of documented command ids (the printer-connection spec).
- Checks that the command fits the current print state (the print-control
  spec).

### D7. Configuration
One JSON file (`config.json`, git-ignored), with environment variables able to
override it. Settings: printer IP (optional, discovery fallback), listen
address/port (default `0.0.0.0:8080`), access token (optional), ntfy URL and
topic, and which events are enabled.

## Risks / Trade-offs

- [Firmware update changes the protocol] → the protocol version check warns;
  the fixtures make a regression obvious; re-run phase A against the new bundle
  using REA `compare_bundles`.
- [Stop command misfires and ruins a print] → stop needs explicit confirmation
  plus the state checks; stop is first tested on a throwaway print.
- [No auth in SDCP: anyone on the LAN can already control the printer] → we
  don't make that worse. The optional token protects our API; documentation
  says not to expose port 8080 to the internet.
- [WSL2 NAT blocks UDP broadcast discovery] → the configured IP takes
  precedence (unicast works, as we observed). Document WSL mirrored networking
  as an option.
- [Printer allows only a few WS clients, so the slicer and the service compete]
  → hold one session only; check the behavior during phase A and document it.
- [Bundle is minified, so command names are lost] → the live pass ties each
  UI action to its frames, which gives the meaning back.

## Migration Plan

New and standalone; nothing to migrate. Rollback means stopping the process.
The printer and Elegoo's tools are unaffected.

## Open Questions

- Does the printer report a stable job id (`TaskId`)? If not, the dedupe key
  falls back as described in D4. Specs don't change either way.
- Can the chamber light be controlled through SDCP on this firmware? If not,
  the light requirement becomes status-only. That's a small spec edit, to be
  decided during phase A.
