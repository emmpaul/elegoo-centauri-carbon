# Spec Delta

## MODIFIED Requirements

### Requirement: Normalized live status
The system SHALL keep a status snapshot. The snapshot SHALL hold: connection
state, machine state, print state, current file name, progress percent, current
and total layer, elapsed and remaining time, nozzle, bed and chamber temperatures
(current and target), print speed percent, part, auxiliary, and chamber fan speeds
(percent), Z height, and light state. Raw protocol codes SHALL be mapped to
named states.

#### Scenario: Status update received
- **WHEN** the printer pushes a status message
- **THEN** the snapshot reflects the new values within 1 second
- **AND** codes not in the protocol reference map to a state named "unknown", with the raw code kept

#### Scenario: Status requested while idle
- **WHEN** no status message has arrived for 30 seconds while connected
- **THEN** the system actively requests status from the printer

#### Scenario: Speed, fans, and height
- **GIVEN** a status push with `PrintSpeedPct` 100, `CurrentFanSpeed` `{ModelFan: 100, AuxiliaryFan: 40, BoxFan: 30}`, and `CurrenCoord` `"120.00,95.50,12.40"`
- **WHEN** the snapshot is updated
- **THEN** it holds speed 100, fans 100, 40, and 30, and Z height 12.4

#### Scenario: Malformed coordinates
- **GIVEN** a status push whose `CurrenCoord` is missing or does not hold three numbers
- **WHEN** the snapshot is updated
- **THEN** its Z height is null and the other values are updated as usual
