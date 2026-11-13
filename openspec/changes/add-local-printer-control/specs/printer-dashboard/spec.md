# Spec Delta

## Purpose

Gives the user a phone-friendly, LAN-only web view of the printer: live status,
the camera, and print controls, without Elegoo's app or cloud.

## ADDED Requirements

### Requirement: Live status view
The dashboard SHALL show: printer name, connection state, print state, current
file name, progress percent, current and total layer, elapsed and remaining
time, and nozzle, bed, and chamber temperatures (current and target). Values
SHALL update without a page reload.

#### Scenario: Progress advances
- **WHEN** the printer reports a new progress value
- **THEN** the dashboard shows it within 2 seconds without the user reloading

#### Scenario: Printer offline
- **WHEN** the service loses its session with the printer
- **THEN** the dashboard shows an offline indicator and the time of the last update

### Requirement: Camera view
The dashboard SHALL show the printer's live camera stream. When the stream
cannot be loaded, it SHALL show a placeholder.

#### Scenario: Camera unreachable
- **WHEN** the camera stream fails to load
- **THEN** the dashboard shows a "camera unavailable" placeholder and the rest of the page keeps working

### Requirement: Control buttons
The dashboard SHALL show pause, resume, and stop buttons. Only buttons that are
valid for the current print state SHALL be enabled. Stop SHALL ask for
confirmation before it is sent.

#### Scenario: Stop confirmation
- **WHEN** the user taps stop
- **THEN** the dashboard asks for confirmation and sends the stop only if the user confirms

#### Scenario: Command outcome shown
- **WHEN** a command returns failed or timeout
- **THEN** the dashboard shows the failure to the user

### Requirement: Phone-friendly and installable
The dashboard SHALL be usable at phone width (360 px) with no horizontal
scrolling. It SHALL be installable to a phone home screen as a web app.

#### Scenario: Narrow screen
- **WHEN** the dashboard is opened at 360 px width
- **THEN** all status values and controls are visible without horizontal scrolling
