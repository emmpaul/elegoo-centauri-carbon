# Proposal

## Why

The public GitHub page is the first thing a new user sees, and today it opens with a
plain heading and a long Node-first setup: there is no picture of what the project is,
no social preview card, and the shortest working path (the published Docker image) is
buried under "Run → In Docker" with an image tag, `latest`, that does not exist yet
because only prereleases (`v1.0.0-rc.*`) have been published.

## What Changes

- Add three finished images, unchanged, under `docs/assets/`: `banner-dark.png` and
  `banner-light.png` (2560x640) and `social-preview.png` (1280x640).
- Show the banner at the top of `README.md` with a `<picture>` element that picks the
  dark or light banner from the reader's GitHub theme, with alt text, keeping the `h1`
  heading and the badge row.
- Add a short "Quick start" section to `README.md`, right after the intro and before
  "Requirements": fetch `compose.yaml` and `printer.env.example` with `curl`, generate
  the token with `openssl rand -hex 32`, set `PRINTER_IP`, pick the newest published
  image version, `docker compose up -d`, open the dashboard, and how to reach it from a
  phone on the LAN. It points to the existing Install and Run sections for the
  non-Docker path.
- Fix the `ghcr.io/...:latest` reference in the README's "In Docker" example, which
  names a tag no release has published yet.
- Document in the PR (not in code) that the social preview image is uploaded by hand in
  GitHub Settings → General → Social preview, since GitHub has no API for it.

No code, workflow, `compose.yaml`, or image behavior changes.

## Capabilities

### New Capabilities

None. This change is documentation and static images only; no system behavior changes,
so the change sets `skip_specs: true` instead of inventing a requirement.

### Modified Capabilities

None.

## Impact

- Files: `README.md`, new `docs/assets/*.png` (about 500 KB in total).
- Not affected: `src/`, `web/`, tests, `compose.yaml`, `.github/workflows/`, and the
  container image (the allow-list `.dockerignore` keeps `docs/` out of the build
  context).
- Manual follow-up for the maintainer: upload `docs/assets/social-preview.png` as the
  repository's social preview.
