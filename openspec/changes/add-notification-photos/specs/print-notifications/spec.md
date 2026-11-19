# Spec Delta

## ADDED Requirements

### Requirement: Photos on print Notifications
When photos are turned on, the system SHALL attach a Photo, one still JPEG from the
printer's camera, to the Notifications for the events finished, failed, stopped, and
paused. Notifications for started, offline, and online SHALL never carry a Photo. Photos
SHALL be off by default and SHALL be turned on by one setting for all four events. The
per-event setting SHALL still decide whether an event is sent at all.

#### Scenario: Photos off by default
- **GIVEN** an ntfy topic is configured and the photo setting is not set
- **WHEN** a print finishes
- **THEN** the "print finished" Notification is sent text-only and the camera is not contacted

#### Scenario: Finished with a Photo
- **GIVEN** photos are on and the camera serves frames
- **WHEN** a print finishes
- **THEN** the "print finished" Notification carries a Photo taken from the camera

#### Scenario: Started never carries a Photo
- **GIVEN** photos are on and the "print started" event is enabled
- **WHEN** a print starts
- **THEN** the "print started" Notification is sent text-only and the camera is not contacted

#### Scenario: Event disabled with photos on
- **GIVEN** photos are on and the "print paused" event is disabled
- **WHEN** a print pauses
- **THEN** no Notification is sent and no Photo is taken

### Requirement: Photo taken from the shared camera stream
The system SHALL take the Photo at the moment the event is detected, through the same
single camera connection the dashboard uses: the next whole frame of that connection
when it is open, otherwise a connection opened for the Photo and closed once no viewer
remains. The system SHALL NOT open a second camera connection to the printer. The JPEG
SHALL be sent exactly as the camera sent it.

#### Scenario: Viewer watching
- **GIVEN** a dashboard viewer is watching the camera
- **WHEN** a Photo is taken
- **THEN** it is the next whole frame of the open camera connection, the printer serves no extra camera connection, and the viewer's stream continues

#### Scenario: Nobody watching
- **GIVEN** no viewer is watching the camera
- **WHEN** a Photo is taken
- **THEN** the system opens the camera connection as it does for a viewer, takes one whole frame, and closes the connection again

#### Scenario: Bytes unchanged
- **WHEN** a Photo is attached
- **THEN** the attached bytes equal the JPEG part the camera sent

### Requirement: Photo time limit and text-only fallback
A Notification with photos on SHALL always be delivered. Taking the Photo SHALL take at
most 5 seconds from detection; when no whole frame arrives in time, or the camera cannot
be reached or fails, the system SHALL send the Notification text-only and log why. The 5
seconds SHALL be measured from the event's own detection also when the Photo has to wait
for another Photo being taken; a Photo with no time left SHALL NOT be attempted.

#### Scenario: Camera unreachable
- **GIVEN** photos are on and the camera cannot be reached
- **WHEN** a print fails
- **THEN** the "print failed" Notification is sent text-only and the reason is logged

#### Scenario: Camera too slow
- **GIVEN** photos are on and the camera sends no whole frame within 5 seconds
- **WHEN** a print finishes
- **THEN** the "print finished" Notification is sent text-only no later than 5 seconds after detection plus delivery time

#### Scenario: Two Photo events within 5 seconds
- **GIVEN** photos are on and a Photo is being taken for a "print paused" event
- **WHEN** a print stops 1 second after the pause was detected and the camera sends no whole frame
- **THEN** each Notification is sent no later than 5 seconds after its own event's detection plus delivery time, the "print stopped" one text-only with the reason logged

### Requirement: Photo upload to ntfy
A Notification with a Photo SHALL be published to ntfy as an attachment upload, with the
JPEG as the request body, the title, message, priority, and tags in request headers
(non-ASCII text encoded per RFC 2047), and the file name `photo-<event>.jpg`. A
Notification without a Photo SHALL be published as before.

#### Scenario: Upload headers
- **GIVEN** photos are on
- **WHEN** a "print paused" Notification with a Photo is published for the file `test-print-1.gcode`
- **THEN** ntfy receives an upload to the topic with the JPEG as body, the title "Print paused", the message naming `test-print-1.gcode`, the priority, the tags, and the file name `photo-paused.jpg`

#### Scenario: Non-ASCII file name
- **WHEN** a Notification with a Photo is published for a file name with non-ASCII characters
- **THEN** the message header is RFC 2047 encoded and ntfy shows the file name unchanged

### Requirement: Upload rejected by ntfy
When ntfy answers a Photo upload with a 4xx status, the system SHALL resend the same
Notification once as a text-only publish and log a warning with the status. It SHALL NOT
retry the rejected upload.

#### Scenario: Server without attachments
- **GIVEN** photos are on and the ntfy server answers uploads with 400
- **WHEN** a print finishes
- **THEN** one upload is attempted, the Notification is then published text-only, and a warning with the status is logged

#### Scenario: Photo too large
- **GIVEN** photos are on and the ntfy server answers the upload with 413
- **WHEN** a print fails
- **THEN** the "print failed" Notification is published text-only and a warning with the status is logged

### Requirement: Photo light
A second setting, off by default and without effect unless photos are on, SHALL let the
system turn the chamber light on for the Photo when it is off. The light command SHALL
pass the same state checks as the user's light command; when they refuse, the Photo
SHALL be taken as it is. The system SHALL send no other command for a Photo.

#### Scenario: Light off, Photo light on
- **GIVEN** photos and the Photo light are on, the printer is online, and the chamber light is off
- **WHEN** a print finishes
- **THEN** the system turns the light on, waits for a status push showing it on, takes the Photo, then turns the light off again

#### Scenario: No confirmation in time
- **GIVEN** photos and the Photo light are on and the chamber light is off
- **WHEN** no status push shows the light on before the Photo's time limit runs short
- **THEN** the Photo is taken anyway and the Notification is delivered within the 5 second limit

#### Scenario: Light already on
- **GIVEN** photos and the Photo light are on and the chamber light is on
- **WHEN** a Photo is taken
- **THEN** no light command is sent

#### Scenario: Light state unknown
- **GIVEN** photos and the Photo light are on and the light state has not been reported
- **WHEN** a Photo is taken
- **THEN** no light command is sent and the Photo is taken as it is

#### Scenario: Photo light off
- **GIVEN** photos are on, the Photo light is off, and the chamber light is off
- **WHEN** a Photo is taken
- **THEN** no light command is sent

### Requirement: Light restored after the Photo
After a Photo for which the system sent the command turning the light on, the system
SHALL turn the light off again, unless the light was changed by anyone else meanwhile: a
light command from a user, or a status push showing the light off after it was on. The
system SHALL NOT require a status push showing the light on before turning it off.

#### Scenario: Status push arrives after the Photo
- **GIVEN** the system sent the command turning the light on for a Photo
- **WHEN** no status push shows the light on until after the Photo is taken
- **THEN** the system turns the light off again after the Photo

#### Scenario: User changed the light meanwhile
- **GIVEN** the system turned the light on for a Photo
- **WHEN** a user sends a light command before the Photo is taken
- **THEN** the system does not turn the light off afterwards

#### Scenario: Light switched off elsewhere
- **GIVEN** the system turned the light on for a Photo and a status push showed it on
- **WHEN** a later status push shows it off before the Photo is taken
- **THEN** the system sends no light command afterwards

### Requirement: Test notification with a Photo
The test notification command SHALL attach a real Photo from the camera when photos are
on, SHALL never send a light command, and SHALL report whether it sent the Photo or fell
back to text, with the reason.

#### Scenario: Test with the camera available
- **GIVEN** photos are on and the printer's camera serves frames
- **WHEN** the user runs the test notification command
- **THEN** the test Notification carries a Photo and the command reports that it was sent with a Photo

#### Scenario: Test with the camera unavailable
- **GIVEN** photos are on and the camera cannot be reached
- **WHEN** the user runs the test notification command
- **THEN** the test Notification is sent text-only and the command reports the fallback and its reason

## MODIFIED Requirements

### Requirement: Delivery failure handling
When a notification fails to deliver, the system SHALL retry up to 3 times
with back-off, then log the failure. A delivery failure SHALL NOT affect the
printer session. For a Photo upload, only network errors and 5xx answers SHALL
be retried; a 4xx answer falls back to a text-only publish instead.

#### Scenario: ntfy unreachable
- **WHEN** the notification endpoint cannot be reached
- **THEN** the system retries 3 times, logs the failure, and keeps monitoring the printer

#### Scenario: Upload answered with a server error
- **GIVEN** photos are on and ntfy answers the upload with 503
- **WHEN** a print finishes
- **THEN** the system retries the upload with back-off up to 3 times before giving up and logging the failure
