# Design

## Context

`release.yml` jobs: `verify` → (`release` ∥ `image`) → `sbom` (`needs: [release, image]`).
The `sbom` job uploads assets to the release and edits its notes, so it must still run after
both.

## Goals / Non-Goals

**Goals:** a GitHub release never exists without its image.

**Non-Goals:** changing what the jobs do, the image tags, the SBOM job, or the quick start.

## Decisions

- **D1. `release` needs `image`.** Set `needs: [verify, image]` on the `release` job. Listing
  `verify` keeps the dependency explicit, even though `image` already needs it. Alternative
  considered: create the release as a draft first and publish it after the image is pushed.
  Rejected because it adds steps and permissions for the same outcome.
- **D2. `sbom` unchanged.** It keeps `needs: [release, image]`. It now runs after `release`,
  which already runs after `image`.

## Risks / Trade-offs

- [The release appears a few minutes later] → accepted; that is the point.
- [An image failure leaves a tag with no release] → re-run the failed jobs with
  `gh run rerun <run-id> --failed`. The release skill already covers re-runs.
