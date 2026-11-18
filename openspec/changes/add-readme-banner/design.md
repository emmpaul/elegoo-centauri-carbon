# Design

## Context

See proposal.md (Why). Current state that shapes the approach:

- `README.md` opens with `# Elegoo Centauri Carbon local control`, a badge row, a short
  intro and feature list, then `## Requirements`, `## Install`, `## Try it without the
  printer`, `## Configure`, `## Run` (with `### In Docker`), `## Security`.
- `compose.yaml` runs `ghcr.io/emmpaul/elegoo-centauri-carbon:${IMAGE_TAG:-latest}`,
  reads `printer.env`, and publishes `${PUBLISH_ADDR:-127.0.0.1}:8080`. `IMAGE_TAG` and
  `PUBLISH_ADDR` are read by compose from the shell or a `.env` file next to it.
- `printer.env.example` leaves `ACCESS_TOKEN` empty on purpose; the service refuses to
  listen on `0.0.0.0` (as it does in the container) without a token.
- `.github/workflows/release.yml` pushes the `latest` tag only for non-prerelease tags.
  Only `v1.0.0-rc.1`..`rc.5` exist, so on 2026-11-18 an anonymous GHCR manifest request
  answers 200 for `1.0.0-rc.5` and 404 for `latest`: `docker compose up -d` with the
  default `IMAGE_TAG` fails today. The image package is public (anonymous pull works).
- `docs/deployment.md` already has the curl pattern for the two files (Files and
  settings), the Tailscale setup between a VM and the home node, and the Dokploy HTTPS
  route. It names the maintainer's own domain; the README must not.
- The `.dockerignore` is an allow-list (`package.json`, `pnpm-lock.yaml`, `src/`, `web/`,
  `scripts/healthcheck.ts`), so files under `docs/` never enter the image.
- The HTTP server does no `Host` or `Origin` check, so a proxy such as `tailscale serve`
  in front of `127.0.0.1:8080` works unchanged.

## Goals / Non-Goals

**Goals:**

- A stranger landing on the repository sees what the project is (banner) and can get the
  dashboard running with Docker by copy-pasting one short block, with no command that
  fails on the current release state.
- The quick start says how to reach the dashboard from the same machine, the home LAN,
  a tailnet, and the internet (by link only), without ever suggesting exposing port 8080
  to the internet.

**Non-Goals:**

- Changing `compose.yaml`, `printer.env.example`, `release.yml`, or any code.
- Rewriting the existing Requirements/Install/Run sections, or duplicating
  `docs/deployment.md` in the README.
- Uploading the social preview (GitHub has no API for it; it is a manual step).
- New OpenSpec capability: nothing here is system behavior.

## Decisions

### D1. Assets live in `docs/assets/`, byte-identical to the exports

Copy `banner-dark.png`, `banner-light.png`, `social-preview.png` from the user's export
folder unchanged (same SHA-256), and reference them by relative path
(`docs/assets/banner-dark.png`). No re-encoding or resizing: the files are already
about 120-250 KB, and re-encoding would add a tool step for little gain. The source
folder is an untrusted download, so the only operation on it is a copy plus a PNG
signature and size check; nothing in it is opened by a program other than `cp`,
`sha256sum`, and a header read.

Alternatives: `.github/` (hidden from casual browsing, and GitHub docs conventionally
live under `docs/`); repository root (clutter); externally hosted images (break when the
host changes).

### D2. Banner as `<picture>`, keeping the visible `h1`

```html
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/banner-dark.png">
  <img alt="..." src="docs/assets/banner-light.png" width="100%">
</picture>
```

Placed as the first thing in the README, before the `h1`. The light banner is the
`<img>` fallback, so renderers that ignore `<source>` (npm, some editors) still show an
image. Alt text states what the image says ("Centauri Carbon local control: dashboard,
print control and notifications on your own network"), not "banner".

The `# Elegoo Centauri Carbon local control` heading stays visible, unchanged. GitHub
strips `class`/`style`, so there is no reliable way to show a heading only to screen
readers; keeping it visible preserves the page's document outline, the anchor
(`#elegoo-centauri-carbon-local-control`), and the "Elegoo" brand word the banner leaves
out. The repeat of the title under the banner is an accepted trade-off. The badge row
stays below the heading.

### D3. "Quick start (Docker)" section right after the intro, before Requirements

A `## Quick start` section between "Everything runs locally..." and `## Requirements`,
one shell block plus a few lines of prose:

```sh
mkdir -p ~/printer && cd ~/printer
curl -fsSLO https://raw.githubusercontent.com/emmpaul/elegoo-centauri-carbon/main/compose.yaml
curl -fsSLO https://raw.githubusercontent.com/emmpaul/elegoo-centauri-carbon/main/printer.env.example
cp printer.env.example printer.env && chmod 600 printer.env
# set PRINTER_IP to your printer's address, and ACCESS_TOKEN to a new token:
sed -i "s/^PRINTER_IP=.*/PRINTER_IP=192.0.2.10/; s/^ACCESS_TOKEN=.*/ACCESS_TOKEN=$(openssl rand -hex 32)/" printer.env
# run the newest published version:
echo "IMAGE_TAG=$(curl -fsSL 'https://api.github.com/repos/emmpaul/elegoo-centauri-carbon/releases?per_page=1' | sed -n 's/.*"tag_name": *"v\([^"]*\)".*/\1/p')" > .env
docker compose up -d
grep ACCESS_TOKEN printer.env   # the token the dashboard asks for
```

then "open <http://127.0.0.1:8080/> and enter the token". The `PRINTER_IP` value is
the documentation address `192.0.2.10` (as in `printer.env.example`) with a comment to
replace it; the README prose says to give the printer a fixed address. Exact wording is
apply's, the commands above are the contract. A last line points readers who want to run
it without Docker to [Install](#install) and [Run](#run).

`sed -i` is GNU syntax; macOS `sed` needs `-i ''`. The section says "Linux (or WSL2)"
for the one-block path and tells others to edit `printer.env` by hand, which is also
what the comment says to do. Rationale: Docker hosts for this are overwhelmingly
Linux (Raspberry Pi, home server); a portable `sed` dance would hurt readability.

### D4. Image tag: resolve the newest release at setup time, don't change `latest`

The quick start writes `IMAGE_TAG` into `.env` from the GitHub releases API (newest
release first, prereleases included), using only `curl` and `sed`, no `jq`. This works
today (gives `1.0.0-rc.5`) and keeps working after the first stable release, with no
README edit per release. Below the block, one sentence says the version can also be read
from the Releases page and set by hand in `.env`, and how to update later (`docker
compose pull && docker compose up -d` after changing `IMAGE_TAG`).

Alternatives considered:
- Hard-code `IMAGE_TAG=1.0.0-rc.5`: goes stale every release unless the release skill
  also edits the README (scope creep into `/release`).
- Publish `latest` for prereleases in `release.yml`: changes release semantics (a
  prerelease would become what `latest` users get) and is not a docs change.
- Change the compose default: same problem in another file.

The existing `### In Docker` `docker run` example uses `:latest` as well; it changes to
`:<version>` with "the version from the Releases page (for example `1.0.0-rc.5`)", and
its compose snippet mentions `IMAGE_TAG`. This is the minimum to stop the README naming
a tag that does not exist; once a stable release exists, `latest` would work again, but
an explicit version is the safer advice anyway.

### D5. "Reach it from your phone": four setups, one short list

A `### Reach the dashboard` subsection under Quick start (short list, not a guide):

1. **This machine only** (default): `http://127.0.0.1:8080/`.
2. **Other devices on your home network:** `echo PUBLISH_ADDR=<host LAN IP> >> .env`
   (or `0.0.0.0` for all interfaces), `docker compose up -d`, open
   `http://<host LAN IP>:8080/`; allow port 8080 in the host firewall if it has one.
   Acceptable on a trusted LAN because the token is mandatory. Don't forward the port
   on the router.
3. **From anywhere, privately, with Tailscale:** install Tailscale on the host and the
   phone, then either publish on the tailnet address
   (`echo PUBLISH_ADDR=$(tailscale ip -4) >> .env`, open `http://<tailnet IP or
   MagicDNS name>:8080/`), or keep the default and run `tailscale serve --bg 8080`,
   which serves `https://<machine>.<tailnet>.ts.net/` with a certificate (needs HTTPS
   enabled for the tailnet), and which also lets Android install the dashboard as an
   app. `tailscale serve --bg <port>` is confirmed against `tailscale serve --help` of
   Tailscale 1.104.7 ("Expose an HTTP server running at 127.0.0.1:3000 in the
   background"). Link to Tailscale's Serve docs (https://tailscale.com/kb/1312/serve)
   for details instead of explaining it.
4. **Public HTTPS on your own domain:** behind a reverse proxy over a VPN, as in
   [docs/deployment.md](docs/deployment.md) (Dokploy + Tailscale). Never by exposing
   port 8080.

Each `PUBLISH_ADDR` line appends to `.env`; since D3 writes `.env` with `>`, the
section notes to run the quick start block first. Placeholders only: no personal domain,
no real IPs other than documentation ranges.

### D6. Social preview: file in the repo, upload documented in the PR

`docs/assets/social-preview.png` is committed; the PR description carries the manual
step (Settings → General → Social preview → Edit → Upload an image). No README text
about it: readers don't need it.

## Risks / Trade-offs

- [GitHub API rate limit (60 requests/hour per IP, unauthenticated) or no network to
  api.github.com] → the `IMAGE_TAG=` line ends up empty and compose falls back to
  `latest`, which 404s. Mitigation: the sentence under the block names the Releases page
  and how to set `IMAGE_TAG` by hand; verification checks the pipeline output.
- [Newest release is a prerelease after a stable exists] → users get the prerelease.
  Accepted: prereleases are what the maintainer ships today, and the Releases page note
  covers pinning.
- [`sed -i` differs on macOS] → noted in the section (D3).
- [The banner repeats the title] → accepted (D2).
- [`tailscale serve` syntax changes between Tailscale versions] → link to their docs,
  keep the README to one command.
- [Images add ~500 KB to the repository history] → acceptable once; future edits should
  replace rather than add variants.

## Migration Plan

Docs only. Rollback is reverting the PR. After merge the maintainer uploads the social
preview by hand.
