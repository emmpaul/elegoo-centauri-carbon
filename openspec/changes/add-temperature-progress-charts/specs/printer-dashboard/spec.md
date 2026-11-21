# Spec Delta

## ADDED Requirements

### Requirement: Charts section

Below the status sheet and above the History section, the dashboard SHALL show a
"Charts" section in the History section's style, whose header toggles it and exposes its
expanded state. It SHALL be open by default, and the last open or closed choice SHALL be
remembered on the device. A closed section SHALL request no Readings.

#### Scenario: Status view unchanged

- **WHEN** any existing dashboard state is rendered at 360 × 780 or 1280 × 660
- **THEN** the visible area looks as before this change, with the controls in the same place

#### Scenario: Open by default

- **GIVEN** no stored choice on the device
- **WHEN** the dashboard opens
- **THEN** the Charts section is open with its expanded state true and shows the Temperatures and Job charts

#### Scenario: Closed choice remembered

- **GIVEN** the user closed the Charts section
- **WHEN** the dashboard is opened again on the same device
- **THEN** the section is closed, and no Readings are requested until it is opened

### Requirement: Temperatures and Job charts

The section SHALL show two charts on one shared time axis, each with a single y-axis:
- **Temperatures** (°C): nozzle, bed, and chamber, with the nozzle and bed targets as
  dashed steps.
- **Job** (percent): progress, print speed, and the part, auxiliary, and chamber fans.

Each series SHALL have its own colour, distinct from the state tones, in both themes.

#### Scenario: Printing mid-job

- **GIVEN** Readings for a running job
- **WHEN** the Charts section renders
- **THEN** the Temperatures chart draws three lines and two dashed target steps, and the Job chart draws progress, speed, and the three fans against a 0 to 100 % axis

#### Scenario: Single axis per chart

- **WHEN** either chart renders
- **THEN** it has one y-axis, and layer and Z height appear only in the readout

### Requirement: State, light, and gaps on the time axis

Both charts SHALL show along the time axis:
- the print state as a strip, with paused and material-change spans shaded;
- the light's on spans as a thin line;
- intervals with no Reading for more than 30 seconds as hatched gaps labelled "offline",
  with no line drawn across them.

#### Scenario: Offline gap

- **GIVEN** Readings stop at 16:20 and resume at 16:28
- **WHEN** the charts render that range
- **THEN** the span from 16:20 to 16:28 is hatched and labelled "offline", and no series line crosses it

#### Scenario: Pause shaded

- **GIVEN** Readings in the paused state from 15:10 to 15:20
- **WHEN** the charts render that range
- **THEN** that span is shaded in both charts and the strip shows it as paused

### Requirement: Chart time ranges

The section SHALL offer the ranges "This job", "1 h", "3 h", and "24 h" as one group of
toggle buttons. "This job" SHALL be the default while a job is running and SHALL span from
the job's first Reading to now; "3 h" SHALL be the default otherwise. "This job" SHALL be
disabled when no job is running.

#### Scenario: Default during a job

- **GIVEN** a job is running
- **WHEN** the Charts section opens
- **THEN** "This job" is selected and the charts span from the job's first Reading to now

#### Scenario: Default when idle

- **GIVEN** no job is running
- **WHEN** the Charts section opens
- **THEN** "3 h" is selected and "This job" is disabled

### Requirement: Chart cursor and legend

Touching, dragging over, or hovering a chart SHALL place a cursor on both charts at that
time and show a readout of the nearest Reading: its time, state, light, every visible
series, layer, and Z height. Without a Reading near that time it SHALL read "offline". Each
chart's legend SHALL toggle its series' visibility and expose each toggle's pressed state.

#### Scenario: Readout

- **WHEN** the user touches the Temperatures chart at 15:42
- **THEN** a cursor shows on both charts at 15:42 and the readout lists the Reading's time, state, temperatures, progress, speed, fans, layer, and Z

#### Scenario: Series hidden

- **WHEN** the user toggles "Aux fan" in the Job legend
- **THEN** its line disappears, its toggle reads not pressed, and the readout leaves it out

### Requirement: Chart data as a table

The section SHALL offer a table view of the Readings in the selected range, one row per
minute with every series, layer, and Z height, so the values can be read without the
charts or colour.

#### Scenario: Table view

- **WHEN** the user switches the Charts section to its table view
- **THEN** a table with a header row and one row per minute of the selected range replaces the charts

### Requirement: Charts follow live Readings

An open Charts section SHALL load the selected range once, then append each Reading
received in a `reading` event without reloading the range. It SHALL load the range again
when the dashboard reconnects to the service, since events may have been missed.

#### Scenario: New Reading

- **GIVEN** the Charts section is open on "This job"
- **WHEN** a `reading` event arrives
- **THEN** both charts extend to the new Reading's time, with no new readings request

#### Scenario: Reconnect

- **GIVEN** the Charts section is open and the event stream dropped
- **WHEN** the dashboard reconnects to the service
- **THEN** it requests the selected range again

### Requirement: Trace of a past job

Opening a history row SHALL show that job's Trace in the same two charts, spanning the
whole Trace, with "Partial" shown when the Trace is partial. A job without a stored Trace
SHALL show "No chart for this print".

#### Scenario: Past job opened

- **GIVEN** a stored job with a Trace
- **WHEN** the user opens its history row
- **THEN** the Temperatures and Job charts of its Trace show under the row, from its first to its last Reading

#### Scenario: No Trace

- **GIVEN** a stored job printed before this change
- **WHEN** the user opens its history row
- **THEN** the row shows "No chart for this print"
