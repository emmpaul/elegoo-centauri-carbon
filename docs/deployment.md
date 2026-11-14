# Deployment

This guide runs the service in a container on an always-on machine at home (the
**home node**) and serves it over HTTPS at `printer.emmanuelpaul.com` through a
Dokploy server (the **VM**). Replace the domain with your own.

```
phone ──HTTPS──> VM (Dokploy, Traefik, Let's Encrypt)
                  │  Tailscale
                  v
                home node (Docker, compose.yaml) ──LAN──> printer (SDCP :3030, camera :3031)
```

The VM terminates HTTPS and forwards requests over Tailscale to the home node.
The home node publishes the service's port only on its tailnet address, so
nothing on the internet reaches it directly. HTTPS is also what lets Android
install the dashboard as an app.

The addresses below are placeholders: `192.0.2.10` is the printer,
`100.64.0.10` the home node's tailnet address, `100.64.0.20` the VM's, and
`203.0.113.5` the VM's public address.

## Home node

### Prerequisites

- Docker Engine with the compose plugin (`docker compose version`).
- A 64-bit OS: images are published for `linux/amd64` and `linux/arm64` (a
  PC, or a Raspberry Pi on 64-bit Raspberry Pi OS). 32-bit Pi OS is not
  supported.
- The home node on the same LAN as the printer.
- A fixed printer address: give the printer a DHCP reservation on your router.
  The service finds the printer with a UDP broadcast only when no address is
  set, and that broadcast does not cross Docker's bridge network, so the
  container needs `PRINTER_IP`.

### Files and settings

Get `compose.yaml` and `printer.env.example` from the repository, either with
a clone or just the two files:

```sh
mkdir -p ~/printer && cd ~/printer
curl -fsSLO https://raw.githubusercontent.com/emmpaul/elegoo-centauri-carbon/main/compose.yaml
curl -fsSLO https://raw.githubusercontent.com/emmpaul/elegoo-centauri-carbon/main/printer.env.example
cp printer.env.example printer.env
chmod 600 printer.env
```

Edit `printer.env`. It is what the service reads, and git ignores it in a
clone:

| Variable | Required | Meaning |
| --- | --- | --- |
| `PRINTER_IP` | yes | Printer address, e.g. `192.0.2.10`. |
| `ACCESS_TOKEN` | yes | Token for the dashboard and API; generate it as shown below. The example leaves it empty, and the service refuses to start without one, because it listens on `0.0.0.0` inside the container. |
| `NTFY_URL` | no | ntfy server (default `https://ntfy.sh`). |
| `NTFY_TOPIC` | no | ntfy topic; unset means no notifications. See [notifications.md](notifications.md). |
| `NOTIFY_EVENTS` | no | Comma-separated events that notify, or `none` (default: all). |

Leave `LISTEN_HOST` and `LISTEN_PORT` unset: `compose.yaml` publishes the
container's port 8080. A config file works too: mount it and set
`CONFIG_PATH` to its path in the container. The settings are the ones in the
README's [Configure](../README.md#configure) table.

Generate the token with the command below and set `ACCESS_TOKEN` in
`printer.env` to its output. Don't reuse a token from the repository or
from this guide:

```sh
openssl rand -hex 32
```

Two more variables are read by `docker compose` itself, from the shell or from
a `.env` file next to `compose.yaml` (it holds no secrets):

| Variable | Default | Meaning |
| --- | --- | --- |
| `IMAGE_TAG` | `latest` | Image version to run, e.g. `1.2.0`. Pin a version so upgrades happen when you choose. |
| `PUBLISH_ADDR` | `127.0.0.1` | Host address the dashboard port is published on. Set it to the home node's tailnet address (below). |

```sh
echo IMAGE_TAG=1.2.0 > .env
```

Leave `PUBLISH_ADDR` at its default until [Tailscale](#tailscale-between-the-vm-and-the-home-node)
is set up.

### Image access

The image is `ghcr.io/emmpaul/elegoo-centauri-carbon`, built for
`linux/amd64` and `linux/arm64`. Each release tag `vX.Y.Z` publishes it as
`X.Y.Z` and `latest`; a prerelease tag with a `-` suffix (`v1.3.0-rc.1`)
publishes only `1.3.0-rc.1` and leaves `latest` alone. A package GitHub
creates on first push is private. Either make it public (the repository is
public): on GitHub, the package's **Package settings** → **Change
visibility** → **Public**; or log the home node in with a personal access
token that has `read:packages`:

```sh
docker login ghcr.io -u <github user>
```

### Start

```sh
docker compose pull
docker compose up -d
docker compose ps      # STATUS turns to "healthy" within about 30 s
docker compose logs -f
```

The image's health check requests `/api/status` with the token, so `healthy`
means the service answers and the token in `printer.env` is the one it
checks. A container that exits right away and logs
`refusing to listen on 0.0.0.0 without an access token` has no
`ACCESS_TOKEN`.

Check it from the home node (once `PUBLISH_ADDR` is set, use that address
instead of `127.0.0.1`):

```sh
curl -fsS -H "Authorization: Bearer <token>" http://127.0.0.1:8080/api/status
```

## Tailscale between the VM and the home node

1. Install Tailscale on both machines and join them to your tailnet
   (`sudo tailscale up`). Read each one's address with `tailscale ip -4`.
2. On the home node, add its tailnet address to `.env`
   (`echo PUBLISH_ADDR=100.64.0.10 >> .env`), then `docker compose up -d`
   again. The port is now reachable only over the
   tailnet, not from the LAN or the internet.
3. Limit what the VM can reach. In the tailnet policy file (admin console →
   **Access controls**), tag both machines and allow the VM only port 8080 on
   the home node. Remove the default allow-all rule, or this one adds nothing:

   ```json
   {
     "tagOwners": {
       "tag:dokploy": ["autogroup:admin"],
       "tag:printer-node": ["autogroup:admin"]
     },
     "acls": [
       { "action": "accept", "src": ["tag:dokploy"], "dst": ["tag:printer-node:8080"] },
       { "action": "accept", "src": ["autogroup:member"], "dst": ["*:*"] }
     ]
   }
   ```

   The second rule keeps your own devices' access; narrow it as you like.
   Apply the tags with `sudo tailscale up --advertise-tags=tag:dokploy` on
   the VM and `--advertise-tags=tag:printer-node` on the home node (or from
   the admin console).

The container binds to the tailnet address, so Tailscale must be up before
Docker starts the container after a reboot. If the container is not running
after a reboot, either order Docker after Tailscale
(`sudo systemctl edit docker.service`, add `After=tailscaled.service` and
`Wants=tailscaled.service` under `[Unit]`), or allow binding to an address
that is not up yet with `sysctl net.ipv4.ip_nonlocal_bind=1` (persist it in
`/etc/sysctl.d/`).

## Dokploy route and HTTPS

1. Point DNS at the VM: an `A` record for `printer.emmanuelpaul.com` to
   `203.0.113.5`. If the domain is on Cloudflare, use DNS only (grey cloud)
   so Let's Encrypt's HTTP challenge reaches Traefik.
2. The service is not a Dokploy application, so route it with a Traefik
   dynamic config file. On the VM, create
   `/etc/dokploy/traefik/dynamic/printer.yml` (Dokploy's dynamic directory; it
   also shows under **Traefik File System** in the Dokploy UI):

   ```yaml
   http:
     routers:
       printer-web:
         rule: Host(`printer.emmanuelpaul.com`)
         entryPoints: [web]
         middlewares: [printer-https]
         service: printer
       printer:
         rule: Host(`printer.emmanuelpaul.com`)
         entryPoints: [websecure]
         service: printer
         tls:
           certResolver: letsencrypt
     middlewares:
       printer-https:
         redirectScheme:
           scheme: https
           permanent: true
     services:
       printer:
         loadBalancer:
           servers:
             - url: http://100.64.0.10:8080
   ```

   Traefik watches the directory and picks the file up without a restart. The
   entry point and resolver names are Dokploy's defaults; check
   `/etc/dokploy/traefik/traefik.yml` if yours differ.
3. Check that the Traefik container reaches the home node over the tailnet
   (the container is named `dokploy-traefik` in a default install). The
   command prints one line and gives up after 5 seconds:

   ```sh
   docker exec dokploy-traefik wget -T 5 -S -O /dev/null http://100.64.0.10:8080/api/status 2>&1 | grep -m 1 -e 'HTTP/' -e 'wget:'
   ```

   `HTTP/1.1 401 Unauthorized` means the service is reached and checks the
   token. A `wget:` line is a failure: `can't connect to remote host` means
   the address is reached but nothing listens on the port (check
   `PUBLISH_ADDR`), and `download timed out` means the address is not
   reached.

   If it times out, the container cannot route to tailnet addresses: check
   the ACL above, that `tailscale status` on the VM shows the home node, and
   from the VM's own shell `curl -sS http://100.64.0.10:8080/api/status`. If
   the host reaches it and the container doesn't, use the alternative below.
4. Open `https://printer.emmanuelpaul.com/` and check the certificate.

Traefik does not buffer responses by default, so the live status (SSE) and
the camera (MJPEG) stream through it. Don't add a buffering middleware to the
route.

### The token in URLs and access logs

API clients and the dashboard send the token as a header where they can, but
some requests carry it in the URL as `?token=<token>`: opening the dashboard
the first time, the live status stream, and the camera. Anything that logs
request URLs records it. Keep Traefik's access log off for this route (it is
off unless `accessLog` is set in `traefik.yml`), or treat the log as secret.
If the token leaks, generate a new one, set it in `printer.env`,
`docker compose up -d`, and enter it again in the dashboard.

### Alternative: Cloudflare Tunnel or Tailscale Funnel

If the VM cannot reach the tailnet, skip it and give the home node its own
HTTPS front door. Keep `PUBLISH_ADDR=127.0.0.1` in both cases.

- **Cloudflare Tunnel:** run `cloudflared` on the home node with a tunnel
  whose public hostname `printer.emmanuelpaul.com` points at
  `http://localhost:8080`. No inbound port is opened; Cloudflare terminates
  HTTPS.
- **Tailscale Funnel:** `sudo tailscale funnel --bg 8080` on the home node
  serves it at `https://<node>.<tailnet>.ts.net` (a Tailscale name, not your
  domain).

The token stays required in both cases.

## Upgrade and rollback

Set `IMAGE_TAG` in `.env` to the new version, then pull and restart:

```sh
docker compose pull && docker compose up -d
docker compose ps
```

To roll back, set `IMAGE_TAG` back to the previous version and run the same
two commands. Old versions stay in the registry. `docker image prune` removes
the images you no longer run.

## After deploying

- [ ] `https://printer.emmanuelpaul.com/` loads over HTTPS with a valid
      certificate, and asks for the token.
- [ ] After entering the token, the status is live: progress and temperatures
      change while a print runs, and the connection shows online.
- [ ] The camera shows a moving picture.
- [ ] `curl -s -o /dev/null -w '%{http_code}\n' https://printer.emmanuelpaul.com/api/status`
      prints `401` (no token, refused).
- [ ] Android: Chrome offers **Install app** (or menu → **Add to home
      screen** → **Install**); the installed app opens without the browser
      bar.
- [ ] iOS: Safari → Share → **Add to Home Screen**; the app opens full
      screen and shows the status.
