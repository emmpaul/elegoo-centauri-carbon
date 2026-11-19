# Proposal

## Why

Each release publishes a container image to `ghcr.io/emmpaul/elegoo-centauri-carbon`, but
nothing says what is inside it: the Debian packages of the `node:26-slim` base, the Node
runtime, and the npm production dependencies. Someone deciding whether to run a release on
their home network, or checking it against a new CVE, has to pull the image and scan it
themselves. A software bill of materials (SBOM) generated at release time and published
with the release answers that from the release page.

## What Changes

- The release workflow generates an SBOM for the image it just pushed, one per platform
  (`linux/amd64`, `linux/arm64`), from the pushed image's digest, in SPDX JSON.
- The SBOM files are uploaded as assets of the GitHub release for the tag, named
  `elegoo-centauri-carbon-X.Y.Z-linux-<arch>.spdx.json`.
- The release notes gain a "Software bill of materials" section after the generated notes:
  the image reference pinned by digest, the SBOM asset for each platform, and the format
  and tool that produced them.
- Prereleases (`-` suffix tags) get SBOMs the same way as stable releases.
- The release skill and `docs/deployment.md` mention the SBOM assets.

Not in scope: attaching the SBOM to the image in the registry (BuildKit attestations or
`cosign attest`), signing the image or the SBOM, vulnerability scanning or gating a release
on findings, CycloneDX output, and SBOMs for releases made before this change.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `container-deployment`: a release that publishes the image also publishes an SBOM of
  that image per platform as release assets and lists them in the release notes.

## Impact

- CI: `.github/workflows/release.yml`. The `image` job exposes the pushed digest; a new
  `sbom` job (needs `release` and `image`, `contents: write`, `packages: read`) generates
  the SBOMs, uploads them, and appends the notes section. High-risk path in review because
  it holds `contents: write`.
- New third-party action: `anchore/sbom-action/download-syft` (pinned by major tag, kept
  current by the existing Dependabot `github-actions` updates).
- Docs: `.claude/skills/release/SKILL.md` (what a tag starts, what to check in step 5),
  `docs/deployment.md` (where to find the SBOM).
- No change to the service, the image contents, or the image tags.
