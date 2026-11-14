# Elegoo Centauri Carbon local control

[![CI](https://github.com/emmpaul/elegoo-centauri-carbon/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/emmpaul/elegoo-centauri-carbon/actions/workflows/ci.yml)
[![Tests](https://img.shields.io/github/actions/workflow/status/emmpaul/elegoo-centauri-carbon/ci.yml?branch=main&label=tests&logo=github)](https://github.com/emmpaul/elegoo-centauri-carbon/actions/workflows/ci.yml?query=branch%3Amain)
![Node 26](https://img.shields.io/badge/node-26-339933?logo=nodedotjs&logoColor=white)
![pnpm 10](https://img.shields.io/badge/pnpm-10-F69220?logo=pnpm&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![Protocol SDCP V3](https://img.shields.io/badge/SDCP-V3.0.0-555)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A small service that talks to an Elegoo Centauri Carbon over its local SDCP
protocol and gives you, on your own network:

- a dashboard for your phone or PC with live status and the camera,
- print control: pause, resume, stop, and the chamber light,
- push notifications through [ntfy](https://ntfy.sh) when a print starts,
  finishes, fails, pauses, or stops, and when the printer goes offline or
  comes back.

Everything runs locally; nothing goes through Elegoo's cloud.

## Requirements

- **Node.js 26 or newer.** The service runs its TypeScript directly with
  Node's built-in type stripping, so there is no build step. With
  [nvm](https://github.com/nvm-sh/nvm), the repository's `.nvmrc` selects it:

  ```sh
  nvm install   # once
  nvm use
  ```

- **pnpm.** Node 26 no longer ships Corepack, so `corepack enable` is not
  available. Install pnpm with its standalone installer (the version matches
  `packageManager` in `package.json`):

  ```sh
  curl -fsSL https://get.pnpm.io/install.sh | env PNPM_VERSION=10.33.0 sh -
  ```

  On Windows PowerShell, use
  `Invoke-WebRequest https://get.pnpm.io/install.ps1 -UseBasicParsing | Invoke-Expression`.
  Open a new shell afterwards (or `source` your shell's rc file) so `pnpm` is
  on your `PATH`, and check it with `pnpm --version`.

- The printer and the machine running the service on the same local network.

## Install

```sh
git clone <this repository> elegoo-centauri-carbon
cd elegoo-centauri-carbon
nvm use
pnpm install
pnpm typecheck
pnpm test
```

## Try it without the printer

`pnpm start:fake` runs the service on `127.0.0.1:8080` against a fake printer
and a fake camera with a print running:

```sh
pnpm start:fake
```

Open <http://127.0.0.1:8080/> in a browser, or from another shell:

```sh
curl -s http://127.0.0.1:8080/api/status
```

Stop it with Ctrl-C. Its options (port, token, simulated failures) are in
[docs/api.md](docs/api.md#trying-it-without-the-printer).

## Configure

Copy the example config and edit it. `config.json` is ignored by git, so your
token and topic stay out of the repository.

```sh
cp config.example.json config.json
```

| Setting | Meaning | Environment override |
| --- | --- | --- |
| `printerIp` | Printer address. `null` finds the printer with UDP discovery. | `PRINTER_IP` |
| `listen.host` | Address the API and dashboard listen on (default `0.0.0.0` = every interface; the example config uses `127.0.0.1`). A non-loopback address requires a token. | `LISTEN_HOST` |
| `listen.port` | Port of the API and dashboard (default `8080`). | `LISTEN_PORT` |
| `token` | Access token for the API and dashboard. `null` means no token check, allowed only on a loopback `listen.host`. | `ACCESS_TOKEN` |
| `ntfy.url` | ntfy server (default `https://ntfy.sh`). | `NTFY_URL` |
| `ntfy.topic` | ntfy topic. `null` turns notifications off. | `NTFY_TOPIC` |
| `events` | Which events notify (`started`, `finished`, `failed`, `paused`, `stopped`, `offline`, `online`). | `NOTIFY_EVENTS` |

Settings come from built-in defaults, then the config file, then environment
variables, so an environment variable wins. An empty variable counts as unset.
`NOTIFY_EVENTS` is a comma-separated list of the events to turn on (every
other event is off), or `none`. `CONFIG_PATH` reads the config from another
file than `./config.json`.

### Access token

A non-loopback listen address requires a token. The service refuses to start
when `listen.host` is anything other than `127.0.0.1` (or another
`127.x.x.x` address), `localhost`, or `::1` and no token is set, and prints
which setting to change. The example config listens on `127.0.0.1`, so it
starts as copied, but only this machine can open the dashboard. To reach it
from your phone, set a token and `listen.host` (or `LISTEN_HOST`) to
`0.0.0.0`.

Generate a random token with:

```sh
node -e "console.log(crypto.randomBytes(24).toString('hex'))"
```

and put it in `token` (or `ACCESS_TOKEN`). API clients send it as
`Authorization: Bearer <token>` or `?token=<token>`; the dashboard asks for it
once and remembers it. See [docs/api.md](docs/api.md#access-token).

**Upgrading an install that listens on `0.0.0.0` without a token:** it stops
starting, with
`refusing to listen on 0.0.0.0 without an access token: ...`. Set `token` (or
`ACCESS_TOKEN`) and open the dashboard once with `?token=<token>`, or set
`listen.host` (or `LISTEN_HOST`) to `127.0.0.1` if only this machine uses it.

### Notifications

Notifications are off until you set `ntfy.topic`. Choosing a topic, the phone
app, a test notification (`pnpm notify:test`), and self-hosting ntfy are in
[docs/notifications.md](docs/notifications.md).

## Run

```sh
pnpm start
```

It prints the printer address and the port, for example
`printer 192.168.0.96; API on http://0.0.0.0:8080`. Open
`http://<address of this machine>:8080/` on your phone (this needs
`listen.host` `0.0.0.0` and a token, see [Access token](#access-token)). Stop
it with Ctrl-C.

### On a PC (Linux, macOS, Windows)

Follow [Install](#install) and run `pnpm start`. Allow incoming connections on
the port (8080 by default) in the firewall so your phone can reach it.

### On Windows with WSL2

WSL2's default networking puts Linux behind a NAT, which has two effects:

- **Discovery does not work.** The UDP broadcast that finds the printer does
  not cross the NAT, so `printerIp: null` fails with
  `no printer answered UDP discovery; set printerIp in the config`. Set
  `printerIp` (or `PRINTER_IP`) to the printer's address, which you can read
  on the printer's screen or your router.
- **Other devices can't reach the service directly.** Either turn on mirrored
  networking (`networkingMode=mirrored` under `[wsl2]` in
  `%UserProfile%\.wslconfig`, then `wsl --shutdown`), or forward the port from
  Windows with `netsh interface portproxy`. Then allow the port in the Windows
  firewall.

### On a Raspberry Pi

Any Pi that runs a 64-bit Raspberry Pi OS works; the service is light. Install
Node 26 with nvm and pnpm as in [Requirements](#requirements), then follow
[Install](#install) and [Configure](#configure). To keep it running across
reboots, a systemd unit such as `/etc/systemd/system/centauri.service`:

```ini
[Unit]
Description=Centauri Carbon local control
After=network-online.target
Wants=network-online.target

[Service]
User=pi
WorkingDirectory=/home/pi/elegoo-centauri-carbon
ExecStart=/home/pi/.nvm/versions/node/<version>/bin/node src/main.ts
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

Replace `<version>` with the output of `nvm which 26` (use that full path for
`ExecStart`), then `sudo systemctl enable --now centauri`.

### In Docker

Releases publish an image for 64-bit PCs and Raspberry Pis,
`ghcr.io/emmpaul/elegoo-centauri-carbon`. It is configured with the
environment variables from [Configure](#configure), needs `PRINTER_IP` (UDP
discovery does not reach the printer from a container) and `ACCESS_TOKEN`
(it listens on `0.0.0.0` inside the container), and runs as a non-root user
with a health check.

```sh
docker run -d --name printer --restart unless-stopped \
  -p 127.0.0.1:8080:8080 \
  -e PRINTER_IP=192.0.2.10 -e ACCESS_TOKEN=<token> \
  ghcr.io/emmpaul/elegoo-centauri-carbon:latest
```

Or with the compose file in this repository, which reads `printer.env`:

```sh
cp printer.env.example printer.env   # set PRINTER_IP, and ACCESS_TOKEN to the output of: openssl rand -hex 32
docker compose up -d
```

Both publish the port on `127.0.0.1` only; use `-p 8080:8080` (or
`PUBLISH_ADDR=0.0.0.0` with compose) to reach it from other devices. Serving
it over HTTPS on your own domain, with Dokploy and Tailscale, is in
[docs/deployment.md](docs/deployment.md).

### Installing the dashboard as an app

Browsers install a web app only from HTTPS (or `localhost` on the same
machine). Over plain `http://<lan address>`, Safari on iOS can still add it to
the home screen, but Android won't offer to install it. For the install prompt
on Android, serve the dashboard over HTTPS, for example with `tailscale serve`
or a reverse proxy. Details in [docs/api.md](docs/api.md#dashboard).

## Security

- **Do not expose the service to the internet.** It can pause and stop
  prints and shows your camera, and it is built for a trusted local network,
  not the open internet. Don't forward its
  port on your router. For remote access, use a VPN such as Tailscale or
  WireGuard, or an HTTPS front door reached over one, as in
  [docs/deployment.md](docs/deployment.md).
- **Set a token** (`token` / `ACCESS_TOKEN`) so other devices on your network
  can't pause or stop a print. The service requires one to listen on anything
  but loopback.
- Treat the ntfy topic as a password: anyone who knows it can read your
  notifications. See [docs/notifications.md](docs/notifications.md).

## Documentation

- [docs/api.md](docs/api.md): HTTP API, live events, camera, dashboard, and
  the fake printer (`pnpm start:fake`).
- [docs/notifications.md](docs/notifications.md): ntfy setup and the events
  that notify.
- [docs/deployment.md](docs/deployment.md): the container on a home node,
  HTTPS through Dokploy and Tailscale, upgrades, and the post-deploy checks.
- [docs/sdcp-protocol.md](docs/sdcp-protocol.md): the printer's SDCP protocol
  as this project uses it.

## License

[MIT](LICENSE) © 2026 Emmanuel Paul. Not affiliated with or endorsed by Elegoo.
