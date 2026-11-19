# Spec Delta

## MODIFIED Requirements

### Requirement: Live status view
The dashboard SHALL show: printer name, connection state, print state in words
with a state glyph, current file name, time left with its finish time, progress
percent as a number and as layer ticks, current and total layer, elapsed time,
and nozzle, bed, and chamber temperatures (current, with the target for nozzle
and bed). Values SHALL update without a page reload.

#### Scenario: Progress advances
- **WHEN** the printer reports a new progress value
- **THEN** the dashboard shows it within 2 seconds without the user reloading

#### Scenario: Printer offline
- **WHEN** the service loses its session with the printer
- **THEN** the dashboard shows an offline indicator and the time of the last update

#### Scenario: Printing mid-job
- **GIVEN** the snapshot is printing `benchy.gcode` at 42 %, layer 210 of 500, 3600 s elapsed, 4900 s remaining, updated at 21:19:57
- **WHEN** the dashboard renders it
- **THEN** it shows "Printing", "benchy.gcode", "21:19:57", "1h 22m", "42%", "left · done 22:41", the ticks filled to 42 % in the ok tone, and rows Layer "210 / 500", Elapsed "1h 00m", Nozzle, Bed, and Chamber

#### Scenario: Temperature targets
- **WHEN** a heater's target is 0, within 2° of its current value, or further away
- **THEN** its target column reads "off", "/ <target>°", or "→ <target>°" respectively, and the chamber's target column always reads "—"

#### Scenario: Completed with cleared file name
- **GIVEN** the print state is completed and the printer cleared the file name and progress
- **WHEN** the dashboard renders it
- **THEN** the headline shows the elapsed time and "Done", the ticks are full, the sub-line names the bed temperature with "let it cool", and no file name slot is shown

#### Scenario: Idle
- **GIVEN** the print state is idle
- **WHEN** the dashboard renders it
- **THEN** the headline reads "Ready", the ticks are empty, and the Layer and Elapsed rows are hidden

#### Scenario: Print error
- **GIVEN** the printer is online and the snapshot's error code is non-zero
- **WHEN** the dashboard renders it
- **THEN** a red alert block shows "Error <code>", and code 45 adds "filament low" with "Load filament, then resume."

#### Scenario: Unknown print state
- **GIVEN** the print state name is unknown with code 7
- **WHEN** the dashboard renders it
- **THEN** the status line reads "Unknown state (7)" with a "?" glyph and a neutral note names the code and the machine state

### Requirement: Camera view
The dashboard SHALL show the printer's live camera stream in the camera box,
scaled to fit without cropping. When the stream cannot be loaded, it SHALL show
a "Camera unavailable" placeholder with a Retry button and retry on its own
every 10 seconds. While the printer is offline it SHALL show a "Camera offline"
placeholder with no retry.

#### Scenario: Camera unreachable
- **WHEN** the camera stream fails to load
- **THEN** the dashboard shows a "camera unavailable" placeholder and the rest of the page keeps working

#### Scenario: Automatic retry
- **GIVEN** the camera placeholder shows "Camera unavailable"
- **WHEN** 10 seconds pass
- **THEN** the dashboard opens the stream again

#### Scenario: Printer offline
- **WHEN** the snapshot's connection is not online
- **THEN** the camera box shows "Camera offline" and "Returns with the printer." with no Retry button

### Requirement: Control buttons
The dashboard SHALL show Light, Pause, and Resume buttons and a stop slide,
all always visible. A control SHALL be enabled exactly when the service's
control rules accept its command, the printer is online, and no command is in
flight. A disabled control SHALL differ by shape (dashed outline, no fill, grey
text), not only by colour.

#### Scenario: Stop confirmation
- **WHEN** the user starts to stop the print
- **THEN** the dashboard sends the stop only after the user drags the slide to its end (or completes it from the keyboard), and sends nothing otherwise

#### Scenario: Command outcome shown
- **WHEN** a command returns failed or timeout
- **THEN** the dashboard shows the failure to the user

#### Scenario: Paused print
- **GIVEN** the print is paused and the printer is online
- **WHEN** the dashboard renders the controls
- **THEN** Resume and the stop slide are enabled, and Pause is dashed and disabled

#### Scenario: Light label
- **WHEN** the light is on, off, or unknown
- **THEN** the Light button reads "Light on" with a filled dot and `aria-pressed="true"`, "Light off" with a hollow dot, or "Light —" and is disabled

### Requirement: Phone-friendly and installable
The dashboard SHALL be usable at phone width (360 px) with no horizontal
scrolling. It SHALL be installable to a phone home screen as a web app with the
design's icon, a `#0f0f0f` theme and background colour, and iOS splash images.

#### Scenario: Narrow screen
- **WHEN** the dashboard is opened at 360 px width
- **THEN** all status values and controls are visible without horizontal scrolling

#### Scenario: Install metadata
- **WHEN** a browser reads the web app manifest
- **THEN** it names the app "Printer", uses standalone display, `#0f0f0f` theme and background colours, and lists 192, 512, and maskable 512 icons

## ADDED Requirements

### Requirement: Stop slide
The stop control SHALL be a track the full width of the sheet with a 48 px
thumb. Releasing before the end SHALL spring the thumb back and send nothing.
While dragging, the message slot SHALL state the consequence. From the
keyboard, → SHALL move the thumb a quarter of the track and the fourth press
SHALL send stop; ← or Esc SHALL reset it.

#### Scenario: Early release
- **GIVEN** the stop slide is enabled
- **WHEN** the user drags the thumb to 74 % and releases
- **THEN** the thumb returns to the start and no command is sent

#### Scenario: Dragging shows the consequence
- **WHEN** the user holds the thumb past the start
- **THEN** the message slot reads "Stops <file> at <progress>%" and "Can’t be resumed. Release at the end to confirm.", and past half the track the label reads "Release to stop"

#### Scenario: Completed slide
- **WHEN** the user releases the thumb at the end of the track
- **THEN** the dashboard sends stop with the confirmation flag and the track shows "Stopping…" with a blue ring

#### Scenario: Keyboard stop
- **GIVEN** the thumb has keyboard focus
- **WHEN** the user presses → four times
- **THEN** the dashboard sends stop with the confirmation flag

#### Scenario: Disabled reason
- **WHEN** stop is not allowed
- **THEN** the track is dashed and states why: "Stop unavailable offline", "Stop off · unknown state", "Wait for the printer", "Waiting for printer…", or "No print to stop"

### Requirement: Command message slot
The dashboard SHALL report each command in one inline message slot directly
above the controls, never as an overlay. Only one command SHALL be in flight at
a time. Pending SHALL show a blue ring on the tapped control and an
indeterminate bar; acknowledged SHALL clear after 2.6 seconds; failed and timed
out SHALL stay until the user retries or dismisses them.

#### Scenario: Pending
- **WHEN** the user taps Pause
- **THEN** the button reads "Pausing…" with a blue ring, the slot reads "Sending pause…" and "Waiting for printer · up to 10 s", and every control is disabled

#### Scenario: Acknowledged
- **WHEN** the service answers the pause with outcome acknowledged
- **THEN** the slot reads "Pause acknowledged" and "Printer is pausing." and clears itself after 2.6 seconds

#### Scenario: Failed with code
- **WHEN** the service answers the pause with outcome failed and code 2
- **THEN** the slot reads "Pause failed · code 2" and "Printer rejected it. Nothing changed." with Retry and dismiss buttons, and the Pause button reads "Retry"

#### Scenario: Timed out
- **WHEN** the service answers the pause with outcome timeout
- **THEN** the slot reads "Pause timed out" and "No reply in 10 s. Check state first." in the warn tone, with Retry and dismiss

#### Scenario: Request rejected by the service
- **WHEN** the command request fails with an HTTP error or cannot reach the service
- **THEN** the slot shows the command as failed, without a code, and gives the reason

### Requirement: Stale data treatment
While the printer or the service is not online, the dashboard SHALL keep the
last known values and mark them as stale without relying on colour alone: an
amber banner with the last contact time and minutes since, a dashed status
glyph with "Last known: <state>", a "left at <time> · last known" sub-line,
secondary ink with dashed row dividers, grey ticks without glow, and every
control disabled.

#### Scenario: Offline for six minutes
- **GIVEN** the last update was at 21:13:40 and it is now 21:20:00
- **WHEN** the snapshot's connection is offline
- **THEN** the banner reads "No contact since 21:13, 6 min ago. Last known values. Controls off." and the header shows "Offline" with a hollow red ring

#### Scenario: Service unreachable
- **WHEN** the event stream to the service is closed
- **THEN** the dashboard applies the same stale treatment to the last snapshot it has

### Requirement: Theme
The dashboard SHALL use the dark theme by default and the light theme when the
user chose it or, with no choice stored, when the system prefers light. A
toggle in the header SHALL switch theme and remember the choice on the device.
The theme SHALL be applied before the first paint.

#### Scenario: Toggle remembered
- **WHEN** the user switches to the light theme and reloads the page
- **THEN** the page opens in the light theme without first showing the dark one

#### Scenario: System preference
- **GIVEN** no theme is stored and the system prefers light
- **WHEN** the page opens
- **THEN** it uses the light theme

### Requirement: Laptop layout
At laptop widths the dashboard SHALL place the header on the page background
above the content, the camera in the free width at full height, and the status
sheet as a fixed 420 px panel on the right, with the same reading order as on a
phone.

#### Scenario: 1280 px wide
- **WHEN** the dashboard is opened 1280 px wide and 660 px tall
- **THEN** the camera spans from 24 px to 812 px horizontally, the panel from 836 px to 1256 px, both from 84 px to 636 px vertically

### Requirement: Token screen
When the service requires a token the dashboard does not have, or rejects the
stored one, it SHALL show a token screen with a labelled field, a Show/Hide
toggle, and a Connect button. A rejected token SHALL stay in the field with a
red ring and a "Rejected (401)" alert so it can be edited.

#### Scenario: First run
- **GIVEN** no token is stored and the service answers 401
- **WHEN** the page opens
- **THEN** it shows "Connect to printer", an empty "Access token" field, and Connect

#### Scenario: Wrong token
- **GIVEN** a stored token that the service answers with 401
- **WHEN** the page opens
- **THEN** it shows "Token not accepted", the rejected token masked in the field with a red ring, and the "Rejected (401)." alert

### Requirement: Typography
The dashboard SHALL use Satoshi for interface text and Cabinet Grotesk for the
time-left and percent figures when the font files are installed on the
service, and system fonts otherwise. The font files SHALL NOT be part of the
repository or the published image, and the page SHALL NOT load fonts from a
third-party server.

#### Scenario: Fonts not installed
- **GIVEN** the font files have not been fetched
- **WHEN** the page loads
- **THEN** the font requests answer 404, the page renders in system fonts, and nothing else breaks

#### Scenario: Fonts installed
- **GIVEN** the operator ran the font fetch script
- **WHEN** the page loads
- **THEN** the service serves the font files and the page renders in Satoshi and Cabinet Grotesk

### Requirement: Accessible controls
Every interactive target SHALL be at least 44 px tall. Progress SHALL be
exposed as a progress bar with its value, the stop thumb as a slider with its
value, and the message slot and offline banner as status regions. Under
reduced motion the dashboard SHALL not animate.

#### Scenario: Screen reader progress
- **WHEN** an assistive technology reads the ticks
- **THEN** it finds a progress bar labelled "Print progress" with the current percent

#### Scenario: Reduced motion
- **GIVEN** the system asks for reduced motion
- **WHEN** a command is pending or the thumb springs back
- **THEN** nothing animates
