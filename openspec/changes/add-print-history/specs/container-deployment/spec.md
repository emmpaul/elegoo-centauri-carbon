# Spec Delta

## MODIFIED Requirements

### Requirement: Image runs the service from environment settings

The image SHALL start the service with no config file, reading `PRINTER_IP`,
`LISTEN_HOST`, `LISTEN_PORT`, `ACCESS_TOKEN`, `NTFY_URL`, `NTFY_TOPIC`,
`NOTIFY_EVENTS`, and `DATA_DIR` from the environment, and SHALL honor a mounted file
named by `CONFIG_PATH`. It listens on `0.0.0.0:8080` inside the container by default.

#### Scenario: Run against a printer address

- **GIVEN** a printer (or fake printer) answers on SDCP port 3030 and camera port 3031 at an address
- **WHEN** the image runs with `PRINTER_IP` set to that address and `ACCESS_TOKEN` set
- **THEN** `GET /api/status` with `Authorization: Bearer <token>` answers 200 with the status snapshot

#### Scenario: Run without a token

- **WHEN** the image runs with its default listen address and no `ACCESS_TOKEN` or token in a mounted config
- **THEN** the container exits with a non-zero status and the refusal message from `api-access`

## ADDED Requirements

### Requirement: Archive on a volume

The image SHALL set `DATA_DIR` to `/data`, create `/data` writable by the non-root
service user, and declare it a volume. The shipped compose file SHALL mount a named
volume at `/data`, so replacing the container with a newer image keeps the job archive.

#### Scenario: Default data directory

- **WHEN** the image runs without `DATA_DIR` set
- **THEN** the service writes its archive under `/data` as the non-root user and stays healthy

#### Scenario: Image update keeps history

- **GIVEN** a container started from `compose.yaml` has stored jobs
- **WHEN** it is recreated from a newer image with the same compose file
- **THEN** `GET /api/history` returns the same jobs
