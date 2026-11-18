# Spec Delta

## Purpose

Defines the container image the project publishes and how it runs: what it contains, how
it is configured and health-checked, and which image tags a release produces.

## ADDED Requirements

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
event SHALL push an image.

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
