# Proposal

## Why

The service only runs from a checkout on a machine next to the printer, so it is not
reachable away from home and Android cannot install the dashboard as a PWA (that needs
HTTPS). The user wants it at `printer.emmanuelpaul.com`, with the Dokploy VM as the HTTPS
front door and the service in a container on an always-on home node. Once the service is
on the internet, running it without an access token is no longer acceptable.

## What Changes

- **BREAKING:** the service refuses to start when it listens on a non-loopback address
  without an access token. It exits with a non-zero status and a message naming
  `ACCESS_TOKEN` / `token` and `LISTEN_HOST` / `listen.host`. The default listen address
  stays `0.0.0.0:8080`, so a setup with no token (including the current
  `config.example.json` and every existing install that relies on the defaults) stops
  starting until it sets a token or listens on loopback only. README, `docs/api.md`, and
  `config.example.json` change with it.
- A container image (`Dockerfile`, `.dockerignore`): Node 26 slim, production
  dependencies, the `src/` and `web/` sources, run as a non-root user, with a health check
  against `GET /api/status` that sends the configured token.
- The release workflow builds the image for `linux/amd64` and `linux/arm64` and pushes it
  to `ghcr.io/emmpaul/elegoo-centauri-carbon` on `vX.Y.Z` tags, after the `verify` job,
  tagged `X.Y.Z` and, for tags without a `-` suffix, `latest`.
- A compose file and env example for the home node (printer address set explicitly,
  restart policy, port published on a chosen address only).
- A fake-printer-only script so the image can be checked locally against a fake printer on
  the SDCP and camera ports.
- Deployment docs: home node setup, the Tailscale link between the Dokploy VM and the home
  node, the Dokploy domain and HTTPS route, required env, upgrading by pulling a new tag,
  and the PWA install check on the real domain. README links to them.

## Capabilities

### New Capabilities

- `api-access`: who may reach the HTTP API and dashboard, starting with the rule that the
  service does not start exposed beyond loopback without an access token.
- `container-deployment`: the published container image, how it is configured and
  health-checked, and how release tags turn into image tags.

### Modified Capabilities

None. `openspec/specs/` holds no capability yet; the token behavior of the
`add-local-printer-control` change (token checked when configured) is unchanged and the
new start-up rule is added under `api-access`.

## Impact

- Code: `src/config.ts` (listen/token check), `src/main.ts` (fail fast before discovery),
  `src/service.ts` (same check, so no caller bypasses it), `test/config.test.ts`, a new
  start-up test, `test/support/fake-printer.ts` and `fake-mjpeg.ts` (fixed host/port
  option), new `scripts/run-fake-printer.ts` and `scripts/healthcheck.ts`.
- New files: `Dockerfile`, `.dockerignore`, `compose.yaml`, `printer.env.example`,
  `docs/deployment.md`.
- CI: `.github/workflows/release.yml` gains an `image` job with `packages: write`
  (high-risk path in review).
- Docs: `README.md`, `docs/api.md`, `config.example.json`, `AGENTS.md` commands.
- Users: existing installs listening on `0.0.0.0` without a token must add one (breaking).
  The user runs the release and configures Dokploy and Tailscale from the docs.
