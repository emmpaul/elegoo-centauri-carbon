# Proposal

## Why

`.github/workflows/release.yml` runs its `release` job (creates the GitHub release) and its
`image` job (builds and pushes the container image) in parallel after `verify`. The release
appears within seconds, while the two-platform image build takes minutes. The README quick
start (added in #22) resolves `IMAGE_TAG` from the newest GitHub release, so anyone who runs
it in that window, or after an image job that failed, gets a version with no image, and
`docker compose up -d` fails with "manifest unknown".

## What Changes

- The `release` job waits for the `image` job (`needs: [verify, image]`), so a GitHub
  release exists only once its image is in the registry. If the image job fails, no
  release is created and the tag can be re-run.
- `.claude/skills/release/SKILL.md` describes the new order.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `container-deployment`: "Published on release tags" now requires the image to be pushed
  before the GitHub release for that tag is created.

## Impact

- `.github/workflows/release.yml` (job dependency only; no step changes).
- `.claude/skills/release/SKILL.md` ("How the pieces fit").
- Releases take a few minutes longer to appear, because the release now waits for the image build.
