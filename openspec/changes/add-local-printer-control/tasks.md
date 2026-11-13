# Tasks

## 1. Project setup

- [x] 1.1 Install Node 26 via nvm and add `.nvmrc` (`26`), then install pnpm (standalone installer, since Node 26 ships no Corepack); verify `node --version` prints v26.x and `pnpm --version` prints 10.x in the repo directory
- [x] 1.2 Create `package.json` (type: module, engines node >=26, `packageManager` pinned to an exact `pnpm@10.x` version), `tsconfig.json` (noEmit, strict, erasable syntax only), `.gitignore` (node_modules, config.json, scratch captures), and the scripts `start`, `test` (`node --test`), and `typecheck` (`tsc --noEmit`); run `pnpm install` and commit `pnpm-lock.yaml`; verify `pnpm typecheck` and `pnpm test` both run cleanly on an empty `src/`
- [x] 1.3 Add `config.example.json` with the D7 settings (printerIp 192.168.0.96, listen address, token, ntfy url/topic, enabled events); verify a config loader unit test covers file values, env overrides, and defaults

## 2. Protocol mapping with REA (phase A)

- [x] 2.1 Download `http://192.168.0.96/` assets (`main.*.js`, `runtime.*.js`, `polyfills.*.js`) into their own empty scratch directory and record their hashes plus firmware V1.4.49 in `docs/sdcp-protocol.md`; verify the files and hashes are listed
- [x] 2.2 Static pass: run REA web-bundle analysis and string search on `main.*.js` to extract the WebSocket URL/port, the message envelope, every `Cmd` id with its call site, and the state/error code tables; verify each entry in `docs/sdcp-protocol.md` cites its bundle location and is labeled *static-only*
- [x] 2.3 Live pass, read-only: use REA browser capture on the printer web UI while it sits idle, to record WS frames for the connect, status, and attributes flow; save the frames as `test/fixtures/*.json`; verify the status fields documented in 2.2 appear in the fixtures and are relabeled *observed*
- [x] 2.4 Live pass during a deliberate small test print: capture frames for status during printing, pause, resume, stop, and the light toggle, driven from Elegoo's own web UI; save them as fixtures; verify each control command in the doc is labeled *observed* with its response format
- [x] 2.5 Record answers to the design open questions (stable `TaskId`? light controllable?) and the concurrent-client behavior; if the light can't be controlled, update the print-control spec to make light status-only; verify `openspec validate add-local-printer-control` passes

## 3. Printer connection

- [x] 3.1 Implement UDP discovery plus the configured-IP override; verify unit tests parse a recorded discovery reply and that the configured IP skips discovery
- [x] 3.2 Build a test-only fake SDCP printer (`ws` dev dependency) that replays fixtures and records received frames; verify a smoke test connects to it
- [x] 3.3 Implement the SDCP client: envelope building, request/response correlation by RequestID, the command allow-list from the protocol doc, and the protocol version warning; verify tests show undocumented command ids are refused and an unknown version logs a warning
- [x] 3.4 Implement reconnect with back-off capped at 60 s, plus the idle status poll after 30 s; verify fake-printer tests cover drop → offline → reconnect → online, and the poll after silence (using mock timers)
- [x] 3.5 Implement the status store that normalizes raw codes into named states (unknown codes keep the raw value); verify fixture-driven tests produce the expected snapshots for idle, printing, paused, completed, and error

## 4. Print control

- [x] 4.1 Implement pause, resume, stop, and light commands, with the state checks and the stop confirmation flag; verify tests show disallowed commands send nothing to the fake printer
- [x] 4.2 Implement result reporting (acknowledged / failed with code / timeout after 10 s); verify tests cover all three outcomes against the fake printer

## 5. HTTP API and camera

- [x] 5.1 Implement the `node:http` server: `GET /api/status` (snapshot), `GET /api/events` (SSE), `POST /api/command`, plus optional bearer/query token checks on every route; verify integration tests cover SSE updates within 1 s, command round-trips, and 401 without the token
- [x] 5.2 Implement the `/camera` MJPEG proxy with one shared upstream connection; verify a test with a fake MJPEG source shows two clients share one upstream, and the upstream closes when the last client leaves
- [x] 5.3 Document the API in `docs/api.md`; verify each documented curl example works against the running service with the fake printer

## 6. Dashboard

- [x] 6.1 Build the static dashboard (vanilla TS/HTML/CSS): status panel, progress, temperatures, offline indicator with last-update time; verify by loading it against the fake printer and watching values update without a reload
- [x] 6.2 Add the camera view with an "unavailable" placeholder, and control buttons enabled by state, with stop confirmation and failure messages; verify manually against the fake printer, including a forced camera failure and a timeout
- [x] 6.3 Add the PWA manifest, icons, and service worker, and make the layout work at 360 px; verify a 360 px screenshot shows no horizontal scroll and that the browser offers install

## 7. Notifications

- [x] 7.1 Implement the event detector over snapshot changes (started, finished, failed, paused, stopped, offline after 2 min, online), with dedupe by job + event type; verify tests replay fixture sequences, including a reconnect during the completed state (no duplicate) and a 90 s blip (no offline alert)
- [x] 7.2 Implement the ntfy channel behind a notifier interface: per-event toggles, 3 retries with back-off, failures logged without touching the printer session; verify tests use a fake ntfy endpoint, including the unreachable case
- [ ] 7.3 Document notification setup (ntfy app, topic choice, self-hosting) in `docs/notifications.md`; verify following it delivers a test notification to a phone

## 8. End-to-end on the real printer

- [ ] 8.1 Run the service against 192.168.0.96 during a small test print; verify the dashboard on a phone shows live status and camera, pause/resume work, and a "print finished" notification arrives exactly once
- [ ] 8.2 Write `README.md` (requirements including Node 26 and installing pnpm, config, running on a PC/WSL or Raspberry Pi, the WSL discovery caveat, the security note about not exposing the service to the internet); verify a fresh clone works by following the README

## Workflow follow-up

- Archive the change with `/opsx:archive` after the end-to-end check passes.
