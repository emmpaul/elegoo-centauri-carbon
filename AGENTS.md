# AGENTS.md

Local-first service for an Elegoo Centauri Carbon 3D printer: it speaks the printer's
undocumented SDCP V3 protocol over the LAN and serves a dashboard, print controls, and
ntfy push notifications. User-facing setup lives in `README.md`; this file is what you
need to change the code.

## Commands

Node 26 (`.nvmrc`; `nvm use`) and pnpm 10 (pinned in `packageManager`). There is no build
step: Node runs the `.ts` files directly through type stripping.

```bash
pnpm install
pnpm typecheck                     # tsc for src/test/scripts, web/, and the service worker
pnpm test                          # node --test, every test file
node --test test/status-store.test.ts                          # one file
node --test --test-name-pattern "pauses" test/print-control.test.ts   # one test
pnpm start:fake                    # whole service against a fake printer + camera on 127.0.0.1:8080
pnpm start                         # real service, reads config.json (see config.example.json)
pnpm notify:test                   # sends one test notification to the configured ntfy topic
node scripts/visual-check.ts a1 c3 # shoots the dashboard per design state and diffs it with its reference
```

`scripts/visual-check.ts` is the visual harness: it serves the dashboard with a mocked
API per state id (a1–a8, b1–b2, c1–c5, d1–d2, e1–e4, f1–f2, g1, g2; none means all),
shoots each in both themes, and writes reference | actual | diff with the share of
differing pixels to `scratch/visual/index.html`. It needs `pnpm fonts:fetch` first and
a full Chromium (`CHROMIUM_PATH`, else Playwright's own, `pnpm exec playwright-core
install chromium`); it refuses the headless shell, whose text rendering moves every
share by several percent. `--all-widths` adds the other width. The references are `docs/design/reference/`; the ids and env are listed at the
top of the script.

`pnpm start:fake` is how to see the dashboard without a printer. Its env vars and signals
(`FAKE_CAMERA=down`, `FAKE_REPLIES=129=silent,131=2`, `SIGUSR1` camera down/up, `SIGUSR2`
printer offline/online) are listed at the top of `scripts/run-fake-service.ts`.

Container image (`Dockerfile`, allow-list `.dockerignore`; deployment in `docs/deployment.md`).
`scripts/run-fake-printer.ts` runs only the fake printer and camera on the real ports 3030
and 3031 (`FAKE_HOST`, default `127.0.0.1`); `scripts/healthcheck.ts` is the image's
`HEALTHCHECK`. Check the image against the fake printer (Linux Docker Engine, host network),
then remove the container:

```bash
docker build -t ecc:dev .
node scripts/run-fake-printer.ts &
docker run -d --name ecc-check --network host -e PRINTER_IP=127.0.0.1 -e ACCESS_TOKEN=t -e LISTEN_PORT=18080 ecc:dev
curl -fsS -H "Authorization: Bearer t" http://127.0.0.1:18080/api/status   # the snapshot
docker inspect -f '{{.State.Health.Status}}' ecc-check                      # healthy after ~30 s
docker run --rm ecc:dev                    # no token: exits non-zero with the refusal message
docker rm -f ecc-check; kill %1
```

## Architecture

One process, wired in `src/service.ts`:

```
printer (WS :3030) <-> sdcp-client <- printer-session -> status-store -> event-detector -> notifier (ntfy)
                                            ^                 |
                                     print-control <---------+--> http-server: /api/status, /api/events (SSE),
                                                                   /api/command, /camera (camera-proxy), dashboard
```

- **`status-store` is the single source of truth.** Raw SDCP status pushes become one
  normalized snapshot (`StatusSnapshot`); the HTTP API, SSE, dashboard, and event detector
  all read that snapshot, never raw frames.
- **Two guards sit in the command layer**, so no caller can bypass them: the command-id
  allow-list in `sdcp-client.ts`, and the per-state rules in `control-rules.ts`.
  `control-rules.ts` is shared with the browser (`web/app.ts` imports it), so a button is
  enabled exactly when the server would accept the command. Change the rules there, once.
- **`printer-session` owns liveness**: reconnect with back-off capped at 60 s, a status
  poll after 30 s of silence, and a timed-out status request counts as a lost session.
- **The dashboard (`web/`) has no bundler.** `src/dashboard-files.ts` serves a fixed
  allow-list of paths and strips types from `.ts` sources on request (so `/app.js` is
  `web/app.ts`). A new browser file needs an entry in that map. Browser code imports
  sibling modules as `./mjpeg.js` and shared ones as `../src/control-rules.ts`.
- **Event dedupe keys on the job's `TaskId`.** The printer clears `TaskId`, progress, and
  file name in the completion push, so the detector remembers the last non-empty one. A
  failed print's error code comes from a Cmd 321 lookup when the job ends.

## The protocol is reverse-engineered

`docs/sdcp-protocol.md` is the reference. Every entry is labeled *observed* (seen on the
wire, with a fixture frame) or *static-only* (read from the printer's web UI bundle,
never confirmed). Check the label before relying on a field or code, and read its "Open
points" section: control-command responses (`Ack`) and the stopped codes 8 and 14 are
still unconfirmed. `docs/api.md` documents the HTTP API; keep it in step with
`http-server.ts`.

## Tests

- `node --test` runs **every** `.ts` under `test/`, helpers included, so put long-running
  scripts in `scripts/`, never in `test/`.
- Tests use fakes on 127.0.0.1 only: `test/support/fake-printer.ts` (replays fixtures,
  records received frames, `goSilent()`), `fake-mjpeg.ts`, `fake-ntfy.ts`. Timing tests use
  `node:test` mock timers.
- `test/fixtures/*.json` are recorded from a real printer. This repo is public: any new
  capture is redacted before it is committed (MAC → `00:00:00:00:00:00`, LAN IP →
  `192.0.2.10`, print file names → `test-print-<n>.gcode`, consistently across files).

## TypeScript rules that bite

Code must run under Node's type stripping, so only erasable syntax (`erasableSyntaxOnly`):
no `enum`, no `namespace`, no constructor parameter properties. Relative imports carry
the `.ts` extension, and type-only imports use `import type` (`verbatimModuleSyntax`).

## Workflow

- **OpenSpec.** Changes are planned under `openspec/changes/<name>/` (proposal, design,
  specs, tasks) and driven by the `opsx` commands and `openspec-*` skills in `.claude/`.
  Commit scope is the change name: `feat(add-local-printer-control): …`.
- **`main` is protected**: changes land through a PR, and the `typecheck and test` check
  must pass on an up-to-date branch. Merge by rebase or squash (merge commits are off).
- **Commits** are Conventional Commits with no AI attribution lines.
- **Releases** go through the `/release` skill: it bumps `package.json` in a release PR,
  tags `vX.Y.Z`, and `.github/workflows/release.yml` publishes the GitHub release. The
  tag must equal `v` + the `package.json` version.
- **Dependabot** opens weekly npm and Actions PRs; patch and minor ones auto-merge once
  CI passes, majors wait for review.
