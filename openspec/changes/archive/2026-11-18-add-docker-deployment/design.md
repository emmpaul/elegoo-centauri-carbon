# Design

## Context

See proposal.md (Why). Current state that shapes the approach:

- Node 26 runs the `.ts` sources directly; there is no build step. `package.json` has no
  `dependencies` today (only devDependencies; `ws` is used by the test fake printer only),
  so production `node_modules` is empty, but the image must stay correct when one is added.
- `src/config.ts` `loadConfig()` merges defaults (`0.0.0.0:8080`, token `null`), the JSON
  file, then env. `src/main.ts` loads the config, resolves the printer (UDP discovery when
  `printerIp` is null), then calls `startService()` in `src/service.ts`. The token is only
  checked per request in `src/http-server.ts` when set.
- `sdcpUrl()` and `cameraUrl()` hard-code ports 3030 and 3031. The test fakes
  (`test/support/fake-printer.ts`, `fake-mjpeg.ts`) bind `127.0.0.1` on a free port, so
  the container cannot be pointed at them as they are.
- `release.yml` has `verify` (tag = `package.json` version, tag on `main`, typecheck,
  test) and `release` (`needs: verify`, `contents: write`). Workflow-level permission is
  `contents: read`. Actions are pinned by major tag (`actions/checkout@v7`).
- Topology (fixed by the user): container on a home node on the printer's LAN; Dokploy VM
  on another network terminates HTTPS for `printer.emmanuelpaul.com` and forwards to it.

## Goals / Non-Goals

**Goals:**

- One image per release, for amd64 PCs and 64-bit Raspberry Pi OS.
- The service cannot be started exposed without a token, from any entry point.
- A local, repeatable check that the built image serves `/api/status` from a fake printer.
- Docs a user can follow end to end without reading the code.

**Non-Goals:**

- Running the release, or changing the user's Dokploy, Tailscale, DNS, or GHCR settings.
- `linux/arm/v7` (32-bit Pi OS) images.
- A login page, users, or token rotation; the existing single token stays the only auth.
- Minimum token length or entropy checks (docs give `openssl rand -hex 32`).
- UDP discovery from inside the container.
- Publishing images on pushes to `main` or on pull requests.

## Decisions

### D1. Mandatory token beyond loopback, enforced by the service

The service refuses to start when the listen host is not loopback and no token is set
(spec `api-access`). A pure function in `src/config.ts` (`listenAuthError(listen, token)`
returning an error message or `null`) holds the rule. `src/main.ts` calls it right after
`loadConfig()`, before discovery, prints the message to stderr and exits with status 1.
`startService()` calls it too and throws before opening any socket, so tests, scripts, and
future entry points cannot bypass it, in line with the repo's "guards no caller can
bypass" pattern. Loopback is decided on the configured string: `localhost`, `::1`, or an
IPv4 address in `127.0.0.0/8` (checked with `node:net` `isIPv4`); everything else,
including host names other than `localhost`, needs a token.

*Alternative considered:* keep the token optional and make the deployment docs require an
authenticating layer in front (Dokploy basic auth, Cloudflare Access, Tailscale-only
access). Rejected as the default: it relies on every user configuring the proxy correctly,
and a container published on the wrong interface would be open. Docs still recommend
keeping the port reachable only over the tailnet, as defence in depth.

*Alternative considered:* change the default listen host to `127.0.0.1` so a fresh install
starts without a token. Rejected: it silently changes who can reach an existing install.
Keeping `0.0.0.0` makes the breaking change loud: the service stops with a message that
says what to set.

`config.example.json` changes to `listen.host: "127.0.0.1"` so the copied example starts
as is; README tells users to set a token and `0.0.0.0` to reach the dashboard from a
phone. The test that loads the example is updated to match.

### D2. Image layout

Two stages on `node:26-slim` (major from `.nvmrc`):

1. `deps`: install pnpm at the version in `package.json` `packageManager` (`npm install -g
   pnpm@<version>`, passed as a build `ARG` with that default), copy `package.json` and
   `pnpm-lock.yaml`, run `pnpm install --prod --frozen-lockfile`.
2. runtime: `NODE_ENV=production`, copy `node_modules` from `deps`, `package.json`,
   `src/`, `web/`, and `scripts/healthcheck.ts`; `USER node`; `EXPOSE 8080`;
   `CMD ["node", "src/main.ts"]`; `HEALTHCHECK` running `node scripts/healthcheck.ts`.

`.dockerignore` is an allow-list style ignore (`*` then `!` the paths above) so new files,
`config.json`, captures, `.git`, `test/`, and `node_modules/` stay out by default.

*Alternative:* skip the install stage since there are no production dependencies today.
Rejected: the image would break silently the day a runtime dependency is added.

### D3. Health check script reads the same config

`scripts/healthcheck.ts` calls `loadConfig()` so it sees the same token and port whether
they come from env or a mounted `CONFIG_PATH` file, requests
`http://<host>:<port>/api/status` (host `127.0.0.1` when the listen host is `0.0.0.0` or
`::`, else the listen host), with a bearer header when a token is set and a 3 s timeout,
and exits 0 only on 200. Lives in `scripts/` (not `test/`) so `node --test` never runs it.

### D4. Image job in `release.yml`

A new job `image` with `needs: verify`, parallel to `release`, `permissions: contents:
read, packages: write` scoped to that job only (workflow default stays `contents: read`).
Steps: `actions/checkout@v7` (`persist-credentials: false`), `docker/setup-qemu-action`,
`docker/setup-buildx-action`, `docker/login-action` to `ghcr.io` with `github.actor` and
`secrets.GITHUB_TOKEN`, a shell step that computes tags from `GITHUB_REF_NAME`
(`version=${GITHUB_REF_NAME#v}`; always `IMAGE:$version`; add `IMAGE:latest` only when
`$version` has no `-`), then `docker/build-push-action` with `platforms:
linux/amd64,linux/arm64`, `push: true`, those tags, and OCI labels
(`org.opencontainers.image.source`, `.version`, `.revision`) so GHCR links the package to
the repo. `IMAGE` is the literal `ghcr.io/emmpaul/elegoo-centauri-carbon`. Actions use the
current major tags, as the rest of the repo does; Dependabot already watches Actions.

*Alternative:* `docker/metadata-action` for tags. Rejected: two tags and one rule are
clearer as five lines of shell that a reviewer can read in the diff.

### D5. Link between the Dokploy VM and the home node: Tailscale

Default (user's preference, keeps Dokploy as the front door): Tailscale on the Dokploy VM
and on the home node. The container publishes 8080 only on the home node's tailnet
address (`PUBLISH_ADDR` in `compose.yaml`, default `127.0.0.1`). On the VM, a Traefik
dynamic config file in Dokploy's Traefik directory routes `Host(\`printer.emmanuelpaul.com\`)`
with Let's Encrypt to `http://<home-node-tailnet-ip>:8080`. A Tailscale ACL limits the VM
to port 8080 on the home node. Docs include a reachability check from the Traefik
container.

*Alternative:* Cloudflare Tunnel (`cloudflared` on the home node) or Tailscale Funnel,
with the Dokploy VM unused. Simpler (no inbound path, no VM hop) but moves the front door
off Dokploy, which the user chose. Docs mention it as the fallback if the VM cannot reach
the tailnet.

### D6. Compose file and env

`compose.yaml` at the repo root: `image: ghcr.io/emmpaul/elegoo-centauri-carbon:${IMAGE_TAG:-latest}`,
`env_file: printer.env`, `restart: unless-stopped`, ports
`${PUBLISH_ADDR:-127.0.0.1}:8080:8080`, default bridge network (printer reached by
`PRINTER_IP`, outbound from the bridge). `printer.env.example` lists the variables;
`printer.env` is added to `.gitignore`. The env file is not named `.env*` because that
matches the repo's secret-like file names.

### D7. Local image check against a fake printer

`scripts/run-fake-printer.ts` runs only the fake printer and fake camera, on
`FAKE_HOST` (default `127.0.0.1`) ports 3030 and 3031, reusing the simulation in
`scripts/run-fake-service.ts` (moved into a shared module under `scripts/`, so both
scripts drive the same state). `FakePrinter.start` and `FakeMjpegSource.start` gain
optional `host` and `port` options (defaults unchanged). The check: start it, then
`docker run --rm --network host -e PRINTER_IP=127.0.0.1 -e ACCESS_TOKEN=… -e
LISTEN_PORT=18080 <image>` and `curl` `/api/status` with the bearer header. Host networking
is only for this local check (Docker Engine on Linux); production uses the bridge.

## Risks / Trade-offs

- [Existing installs on `0.0.0.0` without a token stop starting after upgrade] → Breaking
  change called out in the proposal, README, `docs/api.md`, and the release notes; the
  error message says exactly what to set.
- [Token in `?token=` query strings lands in Traefik access logs on the VM] → Docs say to
  keep Dokploy access logs off for this route or accept it; the dashboard stores the token
  and sends it as a header where it can.
- [Traefik container on the VM cannot route to tailnet addresses] → Docs give a check
  (`wget` from the Traefik container to the home node) and the Cloudflare Tunnel fallback.
- [GHCR package is private on first push] → Docs tell the user to make the package public
  (repo is public) or `docker login ghcr.io` on the home node.
- [SSE and MJPEG streams buffered or cut by the proxy] → Traefik does not buffer by
  default; the post-deploy checklist checks live status and the camera on the real domain.
- [arm64 build under QEMU is slow] → No native compilation (no runtime deps); job timeout
  set to 30 minutes.
- [A new third-party action with `packages: write`] → Only `docker/*` official actions,
  only in the `image` job, `persist-credentials: false` on checkout.

## Migration Plan

1. Merge; existing users set `ACCESS_TOKEN` (or `listen.host: 127.0.0.1`) before
   upgrading.
2. User cuts a release with `/release`; the `image` job publishes `X.Y.Z` and `latest`.
3. User follows `docs/deployment.md` on the home node and the Dokploy VM.
4. Rollback: set `IMAGE_TAG` to the previous version and `docker compose up -d`; the
   startup check itself is reverted by reverting its commit.
