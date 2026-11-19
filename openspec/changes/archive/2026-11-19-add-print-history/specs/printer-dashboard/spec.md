# Spec Delta

## ADDED Requirements

### Requirement: History section

Below the status sheet the dashboard SHALL show a "History" section, collapsed by
default, whose header toggles it and exposes its expanded state. Opened, it SHALL list
past jobs newest first from the history API and load the next page when the end of the
list scrolls into view, in the existing style in both themes. The last open or closed
choice SHALL be remembered on the device.

#### Scenario: Collapsed by default

- **GIVEN** no stored choice on the device
- **WHEN** the dashboard opens
- **THEN** the History header is shown with its expanded state false, no rows are shown, and no history request is made

#### Scenario: Open loads the first page

- **WHEN** the user opens the History section
- **THEN** the dashboard requests the first page of the history and shows its rows

#### Scenario: Scroll loads more

- **GIVEN** the History section is open and the last page loaded has a `next` cursor
- **WHEN** the end of the list scrolls into view
- **THEN** the dashboard requests the page before that cursor and appends its rows, and stops requesting once `next` is null

#### Scenario: Status view unchanged

- **WHEN** any existing dashboard state is rendered at 360 × 780 or 1280 × 660
- **THEN** the visible area looks as before this change

### Requirement: History rows

Each history row SHALL show the job's thumbnail (or a placeholder without one), its file
name, start and end time (with the date when not today), duration, layers printed of the total, and its outcome in
words. A failed job SHALL show "Error <code>", with "filament low" for code 45; a stopped
job SHALL read "Stopped"; a running job SHALL read "Printing" with no end time or duration.

#### Scenario: Completed row

- **GIVEN** a browser on UTC and a completed job `test-print-1.gcode` from 20:05:58 to 21:18:13 today, 180 of 180 layers
- **WHEN** its row renders
- **THEN** it shows the thumbnail, "test-print-1.gcode", "20:05", "21:18", "1h 12m", "180 / 180", and "Completed"

#### Scenario: Earlier day

- **GIVEN** a job that started on an earlier day than today
- **WHEN** its row renders
- **THEN** its start shows the day and month before the time, for example "13 Nov 20:05"

#### Scenario: Failed row

- **GIVEN** a job with outcome failed and error code 45
- **WHEN** its row renders
- **THEN** its outcome reads "Error 45 · filament low" in the error tone

#### Scenario: No thumbnail

- **GIVEN** a job without a thumbnail
- **WHEN** its row renders
- **THEN** a neutral placeholder takes the thumbnail's place and the row keeps its height

### Requirement: History refresh and empty states

While open, the History section SHALL reload its first page when the event stream sends
a `history` event. It SHALL show "No prints yet" when the archive is empty, and a failed
load SHALL show an inline message with a Retry button without affecting the status view.

#### Scenario: Job ends while open

- **GIVEN** the History section is open
- **WHEN** the event stream sends a `history` event
- **THEN** the list is reloaded from its first page and shows the new job at the top

#### Scenario: Empty archive

- **GIVEN** the history API answers no jobs
- **WHEN** the user opens the History section
- **THEN** it shows "No prints yet"

#### Scenario: Load fails

- **GIVEN** the history API answers 500
- **WHEN** the user opens the History section
- **THEN** it shows "History unavailable" with a Retry button, and the status sheet keeps updating
