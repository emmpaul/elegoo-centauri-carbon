# Spec Delta

## Purpose

Lets a user pause, resume, or stop the current print and toggle the chamber
light from the local service, and tells them whether the printer accepted each
command.

## ADDED Requirements

### Requirement: Pause, resume, and stop
The system SHALL offer pause, resume, and stop for the current print. It SHALL
send each one to the printer using the command documented in the protocol
reference.

#### Scenario: Pause a running print
- **GIVEN** a print is running
- **WHEN** the user requests pause
- **THEN** the system sends the pause command and the status snapshot shows the print as pausing or paused

#### Scenario: Resume a paused print
- **GIVEN** a print is paused
- **WHEN** the user requests resume
- **THEN** the system sends the resume command and the status snapshot shows the print as running

### Requirement: Commands checked against current state
The system SHALL reject a control command that does not fit the current print
state. Examples: resume while not paused, or pause or stop while no print is
active. The rejection SHALL NOT send anything to the printer.

#### Scenario: Resume while not paused
- **GIVEN** no print is paused
- **WHEN** the user requests resume
- **THEN** the system returns a "not allowed in current state" error and sends nothing to the printer

### Requirement: Stop requires explicit confirmation
The system SHALL require an explicit confirmation flag on a stop request. A
stop request without that flag SHALL be rejected.

#### Scenario: Stop without confirmation
- **WHEN** a stop request arrives without the confirmation flag
- **THEN** the system rejects it and the print continues

### Requirement: Command result reporting
For every command sent, the system SHALL report its outcome. The outcome is
"acknowledged" when the printer's response says success. It is "failed", with
the printer's error code, when the response says failure. It is "timeout" when
no response arrives within 10 seconds.

#### Scenario: Printer does not respond
- **WHEN** a command gets no response within 10 seconds
- **THEN** the system reports the command as "timeout"

### Requirement: Chamber light toggle
The system SHALL let the user turn the chamber light on or off, and the status
snapshot SHALL show the resulting light state.

#### Scenario: Turn light off
- **WHEN** the user turns the light off
- **THEN** the system sends the light command and the snapshot shows the light as off once the printer confirms it

### Requirement: Access control on control actions
When an access token is configured, the system SHALL reject any control command
that does not carry a matching token. Reading status SHALL follow the same
rule.

#### Scenario: Missing token
- **GIVEN** an access token is configured
- **WHEN** a control request arrives without the token
- **THEN** the system responds with an authorization error and sends nothing to the printer
