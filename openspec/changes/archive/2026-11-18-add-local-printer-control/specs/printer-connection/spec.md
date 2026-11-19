# Spec Delta

## Purpose

Lets the service find the Centauri Carbon on the LAN, keep a live session with
it over its local SDCP protocol, and expose one normalized view of printer state
that the dashboard and notifications read.

## ADDED Requirements

### Requirement: Printer discovery
The system SHALL find SDCP printers on the local network by UDP broadcast. It
SHALL also accept a manually configured printer address, which takes precedence
over discovery.

#### Scenario: Printer answers discovery
- **WHEN** the system sends a discovery probe and a printer replies
- **THEN** the system records the printer's id, name, IP address, mainboard id, protocol version, and firmware version

#### Scenario: Configured address used
- **GIVEN** the printer address is configured as 192.168.0.96
- **WHEN** the system starts
- **THEN** it connects to 192.168.0.96 without waiting for discovery

### Requirement: Protocol version check
The system SHALL read the printer's reported SDCP protocol version. It SHALL
warn when that version differs from the versions listed in the protocol
reference, but SHALL still try to connect.

#### Scenario: Unknown protocol version
- **WHEN** the printer reports a protocol version not listed in the protocol reference
- **THEN** the system logs a warning that names the reported version and continues connecting

### Requirement: Persistent session with reconnect
The system SHALL keep one open SDCP session to the printer. When the session
drops, it SHALL reconnect with increasing back-off, capped at 60 seconds between
attempts.

#### Scenario: Printer reboots
- **WHEN** the session closes unexpectedly
- **THEN** the system marks the printer offline and retries until the session is restored
- **AND** marks the printer online again once a status message is received

### Requirement: Normalized live status
The system SHALL keep a status snapshot. The snapshot SHALL hold: connection
state, machine state, print state, current file name, progress percent, current
and total layer, elapsed and remaining time, nozzle, bed and chamber temperatures
(current and target), and light state. Raw protocol codes SHALL be mapped to
named states.

#### Scenario: Status update received
- **WHEN** the printer pushes a status message
- **THEN** the snapshot reflects the new values within 1 second
- **AND** codes not in the protocol reference map to a state named "unknown", with the raw code kept

#### Scenario: Status requested while idle
- **WHEN** no status message has arrived for 30 seconds while connected
- **THEN** the system actively requests status from the printer

### Requirement: Only documented messages are sent
The system SHALL send only documented messages to the printer. Message types
not in the protocol reference SHALL NOT be sent.

#### Scenario: Undocumented command blocked
- **WHEN** code attempts to send a command id that the protocol reference does not list
- **THEN** the system refuses to send it and logs an error
