# Tasks

## 1. Images

- [x] 1.1 Copy `banner-dark.png`, `banner-light.png`, and `social-preview.png` from `/mnt/c/Users/emman/Downloads/GitHub public banner prep/export/` into `docs/assets/` with `cp` only (untrusted download: run nothing from that folder; design D1). Verify `sha256sum` of each copy equals its source (expected `ebca6162…fbf8e` dark, `93c0d2c3…e676a` light, `a04a6f3c…a5f63` social), each starts with the PNG signature and has the size 2560x640, 2560x640, 1280x640 from its IHDR header, and `git check-ignore docs/assets/*.png` prints nothing.

## 2. README banner

- [x] 2.1 Add the `<picture>` banner from design D2 as the first lines of `README.md` (dark `<source media="(prefers-color-scheme: dark)">`, light `<img>` fallback with descriptive alt text and `width="100%"`), keeping `# Elegoo Centauri Carbon local control` and the badge row below it unchanged. Verify `grep -c 'docs/assets/banner-' README.md` is 2, both referenced files exist, `git diff README.md` shows no change to the heading or badge lines, and the rendered README (`gh api markdown -f mode=gfm -f context=emmpaul/elegoo-centauri-carbon -F text=@README.md` or a GitHub preview) contains the `<picture>` with both sources.

## 3. Quick start

- [x] 3.1 Add `## Quick start` between the intro ("Everything runs locally…") and `## Requirements` with the shell block from design D3 and D4 (curl the two files from `raw.githubusercontent.com/.../main/`, `cp` + `chmod 600`, `sed` setting `PRINTER_IP` and an `openssl rand -hex 32` token, `IMAGE_TAG` resolved from the releases API into `.env`, `docker compose up -d`, show the token), then: open `http://127.0.0.1:8080/` and enter the token; give the printer a fixed address; the version can be read from the Releases page and set by hand in `.env`; how to update (change `IMAGE_TAG`, `docker compose pull && docker compose up -d`); the GNU `sed -i` note; and a pointer to [Install](#install) and [Run](#run) for running without Docker. Verify: `compose.yaml` and `printer.env.example` exist at the repository root (the raw URLs' paths); the block passes `bash -n`; the `IMAGE_TAG` pipeline prints `1.0.0-rc.5` (or the then-newest release) both against the live API and against a saved sample response; and every intra-README anchor used resolves to an existing heading.
- [x] 3.2 Add `### Reach the dashboard` under Quick start with the four setups from design D5 (this machine; home LAN via `PUBLISH_ADDR` + firewall note + don't forward the port; Tailscale via `PUBLISH_ADDR=$(tailscale ip -4)` or `tailscale serve --bg 8080` with HTTPS and the Android install note, linking https://tailscale.com/kb/1312/serve; public HTTPS via [docs/deployment.md](docs/deployment.md)). Verify `grep -n 'emmanuelpaul' README.md` prints nothing, every IP in the new text is a placeholder or in 127.0.0.0/8, 192.0.2.0/24 or 100.64.0.0/10, no sentence suggests forwarding or exposing port 8080 to the internet, and the `tailscale serve` form matches `tailscale serve --help`.
- [x] 3.3 In `### In Docker` and in the `docker run` example of `### Dashboard fonts`, replace `ghcr.io/emmpaul/elegoo-centauri-carbon:latest` with `:<version>` and the Releases-page sentence, and mention `IMAGE_TAG` in its compose snippet (design D4). Verify `grep -n ':latest' README.md` prints nothing.
- [x] 3.4 Run the quick start end to end against the fake printer: start `FAKE_HOST=0.0.0.0 node scripts/run-fake-printer.ts` in the background, then in a fresh `scratch/quickstart/` directory run the README block verbatim except the `PRINTER_IP` value, set to an address of this host that containers reach (e.g. the `docker0` gateway, `ip -4 addr show docker0`). Verify `docker compose ps` shows the service running, `curl -fsS -H "Authorization: Bearer $(sed -n 's/^ACCESS_TOKEN=//p' printer.env)" http://127.0.0.1:8080/api/status` answers 200 with a snapshot whose printer is online, and `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/api/status` is 401; then `docker compose down`, stop the fake printer, delete `scratch/quickstart/`. Record the result for the PR description.

## 4. Integration check

- [ ] 4.1 Run `pnpm typecheck` and `pnpm test` and verify both pass; verify `git diff --stat main...HEAD` touches only `README.md`, `docs/assets/`, and `openspec/changes/add-readme-banner/`, and that the `.dockerignore` allow-list does not include `docs/` (so the image build context is unchanged).

## Workflow follow-up

- In the PR description, state the manual step: upload `docs/assets/social-preview.png` in GitHub Settings → General → Social preview (GitHub has no API for it), and include the 3.4 result.
- After merge, check the README on github.com in both the light and dark theme and on a phone width.
- Archive the change after review (no spec deltas: `skip_specs: true`).
