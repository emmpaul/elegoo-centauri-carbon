# container-deployment Specification

## Purpose

Defines the container image the project publishes and how it runs: what it contains, how
it is configured and health-checked, and which image tags a release produces.

## Requirements

### Requirement: Image runs the service from environment settings

The image SHALL start the service with no config file, reading `PRINTER_IP`,
`LISTEN_HOST`, `LISTEN_PORT`, `ACCESS_TOKEN`, `NTFY_URL`, `NTFY_TOPIC`, and
`NOTIFY_EVENTS` from the environment, and SHALL honor a mounted file named by
`CONFIG_PATH`. It listens on `0.0.0.0:8080` inside the container by default.

#### Scenario: Run against a printer address

- **GIVEN** a printer (or fake printer) answers on SDCP port 3030 and camera port 3031 at an address
- **WHEN** the image runs with `PRINTER_IP` set to that address and `ACCESS_TOKEN` set
- **THEN** `GET /api/status` with `Authorization: Bearer <token>` answers 200 with the status snapshot

#### Scenario: Run without a token

- **WHEN** the image runs with its default listen address and no `ACCESS_TOKEN` or token in a mounted config
- **THEN** the container exits with a non-zero status and the refusal message from `api-access`

### Requirement: Image contents

The image SHALL contain the Node 26 runtime, the production dependencies from the
lockfile, and the `src/` and `web/` sources, and SHALL NOT contain tests, fixtures,
captures, `config.json`, `.git`, or development dependencies. The service SHALL run as a
non-root user.

#### Scenario: No local config or test data in the image

- **WHEN** the image is built from a checkout that has a `config.json` and `test/fixtures/`
- **THEN** neither is present in the image

#### Scenario: Non-root process

- **WHEN** the container runs
- **THEN** the service process runs with a non-zero user id

### Requirement: Health check

The image SHALL declare a health check that requests `GET /api/status` on the listen port,
sends the configured token as a bearer header when one is set, and reports healthy only on
a 200 answer.

#### Scenario: Healthy service

- **WHEN** the service is running with a token and answers `/api/status`
- **THEN** the container's health status becomes `healthy`

#### Scenario: Wrong token in the probe

- **WHEN** the API answers the health probe with 401
- **THEN** the container's health status becomes `unhealthy`

### Requirement: Published on release tags

When a `vX.Y.Z` tag passes the release verification, the system SHALL build the image for
`linux/amd64` and `linux/arm64` and push it to `ghcr.io/emmpaul/elegoo-centauri-carbon`
tagged `X.Y.Z`. It SHALL also tag it `latest` only when the tag has no `-` suffix. No other
event SHALL push an image. The GitHub release for the tag SHALL be created only after the
image has been pushed, so a published release always has its image.

#### Scenario: Stable release

- **WHEN** tag `v1.2.0` is pushed and verification passes
- **THEN** the registry has `1.2.0` and `latest` pointing at the same image

#### Scenario: Prerelease

- **WHEN** tag `v1.3.0-rc.1` is pushed and verification passes
- **THEN** the registry has `1.3.0-rc.1` and `latest` is unchanged

#### Scenario: Verification fails

- **WHEN** the tag does not match `package.json` or the tests fail
- **THEN** no image is pushed

#### Scenario: Pull request or branch push

- **WHEN** a pull request runs CI or a branch is pushed
- **THEN** no image is built or pushed

#### Scenario: Release waits for the image

- **WHEN** tag `v1.2.0` is pushed and verification passes
- **THEN** the GitHub release `v1.2.0` is created only after the `1.2.0` image is in the registry

#### Scenario: Image push fails

- **WHEN** tag `v1.2.0` is pushed, verification passes, and the image build or push fails
- **THEN** no GitHub release `v1.2.0` is created

### Requirement: SBOM published with each release

When a release tag pushes the image, the system SHALL generate a software bill of
materials in SPDX JSON for each published platform, from the image by the digest it
pushed, and attach it to the GitHub release for the tag as
`elegoo-centauri-carbon-X.Y.Z-linux-<arch>.spdx.json`. Prerelease tags SHALL get SBOMs too.

#### Scenario: Stable release

- **WHEN** tag `v1.2.0` is pushed and the image is pushed
- **THEN** the `v1.2.0` release has the assets `elegoo-centauri-carbon-1.2.0-linux-amd64.spdx.json` and `elegoo-centauri-carbon-1.2.0-linux-arm64.spdx.json`
- **AND** each is a valid SPDX JSON document whose subject is the image digest for that platform

#### Scenario: Prerelease

- **WHEN** tag `v1.3.0-rc.1` is pushed and the image is pushed
- **THEN** the `v1.3.0-rc.1` prerelease has both `elegoo-centauri-carbon-1.3.0-rc.1-linux-<arch>.spdx.json` assets

#### Scenario: Contents of the SBOM

- **WHEN** an SBOM asset is read
- **THEN** it lists the operating system packages of the image, the Node runtime, and the npm packages installed in the image

#### Scenario: No image pushed

- **WHEN** verification fails or the image job fails
- **THEN** no SBOM is generated and no SBOM asset is attached

### Requirement: SBOM listed in the release notes

The release notes SHALL keep the generated notes and end with a "Software bill of
materials" section naming the image pinned by its digest, linking each platform's SBOM
asset, and stating the format and the tool and version that produced it. Re-running the
release workflow for a tag SHALL NOT add the section twice.

#### Scenario: Notes after a release

- **WHEN** the release workflow for `v1.2.0` completes
- **THEN** the release notes contain the generated notes followed by one "Software bill of materials" section with `ghcr.io/emmpaul/elegoo-centauri-carbon@sha256:<digest>` and a link to each SBOM asset

#### Scenario: Workflow re-run

- **WHEN** the SBOM step is re-run for a release that already has the section and assets
- **THEN** the assets are replaced and the notes still contain exactly one "Software bill of materials" section
