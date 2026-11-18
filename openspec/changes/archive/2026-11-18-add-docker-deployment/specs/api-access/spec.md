# Spec Delta

## Purpose

Controls who can reach the service's HTTP API and dashboard, so the service is never
exposed beyond the local machine without an access token.

## ADDED Requirements

### Requirement: Refuse to start exposed without a token

The system SHALL refuse to start when its listen address is not a loopback address and no
access token is configured. Loopback addresses are `localhost`, any `127.0.0.0/8` IPv4
address, and `::1`; every other address, including `0.0.0.0`, `::`, a LAN address, and a
host name, counts as non-loopback.

#### Scenario: Wildcard address without a token

- **GIVEN** the listen host is `0.0.0.0` and no token is set in the config file or `ACCESS_TOKEN`
- **WHEN** the service starts
- **THEN** it exits with a non-zero status without opening the listen port or contacting the printer

#### Scenario: LAN address without a token

- **GIVEN** the listen host is `192.0.2.10` and no token is configured
- **WHEN** the service starts
- **THEN** it exits with a non-zero status

#### Scenario: Wildcard address with a token

- **GIVEN** the listen host is `0.0.0.0` and `ACCESS_TOKEN` is set
- **WHEN** the service starts
- **THEN** it starts and requires the token on API requests as before

#### Scenario: Loopback address without a token

- **GIVEN** the listen host is `127.0.0.1`, `localhost`, or `::1` and no token is configured
- **WHEN** the service starts
- **THEN** it starts and serves the API without a token check

### Requirement: Explain the refusal

When the system refuses to start for a missing token, it SHALL print one error message
that names the listen host, the token setting (`token` / `ACCESS_TOKEN`), and the
loopback alternative (`listen.host` / `LISTEN_HOST`).

#### Scenario: Refusal message

- **WHEN** the service refuses to start on `0.0.0.0` without a token
- **THEN** standard error names `0.0.0.0`, `ACCESS_TOKEN`, and `LISTEN_HOST`

### Requirement: No start path bypasses the rule

The rule SHALL hold for every way the service is started in code, not only the command-line
entry point.

#### Scenario: Programmatic start without a token

- **WHEN** code starts the service on a non-loopback address with no token
- **THEN** the start fails with an error and no port is opened
