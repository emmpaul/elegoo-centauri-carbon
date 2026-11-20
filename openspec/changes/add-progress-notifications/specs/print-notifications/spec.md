# Spec Delta

## ADDED Requirements

### Requirement: First layer done event
The system SHALL emit a "first layer done" event for a job when the printer reports the
job on layer 2 or later after the system has seen the same job on layer 0 or 1. Layers
count from 1 as the printer reports them, so layer 2 means the first layer is complete.

#### Scenario: First layer completes
- **GIVEN** the system has seen a running job on layer 1
- **WHEN** a status push reports that job on layer 2
- **THEN** the system emits a "first layer done" event with the file name and progress

#### Scenario: Preparation before the first layer
- **GIVEN** a job has just started and the printer reports it on layer 0 while it heats and levels
- **WHEN** a later status push reports the job on layer 2
- **THEN** the system emits a "first layer done" event

#### Scenario: Service started late in a print
- **GIVEN** the service starts while a job is already on layer 5
- **WHEN** later status pushes report layers 6 and 7
- **THEN** no "first layer done" event is emitted for that job

#### Scenario: Stale layer of the previous job
- **GIVEN** the previous job ended on layer 12 and a new job starts
- **WHEN** the first status push of the new job still reports layer 12, and later pushes report layer 0 and then layer 2
- **THEN** the "first layer done" event is emitted once, on the push reporting layer 2, and not on the push reporting the stale layer 12

### Requirement: Almost done event
The system SHALL emit an "almost done" event for a job when the remaining time the
printer reports drops to 600 seconds or less after the system has seen the same job with
more than 600 seconds remaining. The remaining time is the printer's total time estimate
minus its elapsed print time.

#### Scenario: Ten minutes left
- **GIVEN** the system has seen a running job with 900 seconds remaining
- **WHEN** a status push reports 590 seconds remaining
- **THEN** the system emits an "almost done" event with the file name, progress, and the remaining time

#### Scenario: Short print
- **GIVEN** a job whose total time estimate is 400 seconds
- **WHEN** the job runs to its end
- **THEN** no "almost done" event is emitted for that job

#### Scenario: Stale time of the previous job
- **GIVEN** the previous job ended with 1 second remaining and a new job starts
- **WHEN** the first status push of the new job still reports the previous job's times
- **THEN** no "almost done" event is emitted on that push

### Requirement: Progress events off by default
The "first layer done" and "almost done" events SHALL be off unless the user turns them
on, through the same per-event setting, in the config file or the environment, as every
other event. Turning them on or off SHALL NOT change whether any other event is sent.

#### Scenario: Default configuration
- **GIVEN** an ntfy topic is configured and no event setting names the progress events
- **WHEN** a print completes its first layer and later has ten minutes left
- **THEN** no Notification is sent for either, and the other events are sent as before

#### Scenario: Turned on in the config file
- **GIVEN** the config file turns the "first layer done" event on
- **WHEN** a print completes its first layer
- **THEN** a "first layer done" Notification naming the file is published

#### Scenario: Turned on in the environment
- **GIVEN** the environment lists the events to send as finished, first-layer, and almost-done
- **WHEN** a print has ten minutes left
- **THEN** an "almost done" Notification naming the file and the minutes left is published, and no "print started" Notification is sent for that print

### Requirement: Progress events once per job
The system SHALL send each progress event at most once per job, keyed on the job's id.
This SHALL hold when status pushes repeat, when the session reconnects, when the job is
paused and resumed, and when the reported layer or remaining time moves back across its
threshold.

#### Scenario: Remaining time rises again
- **GIVEN** an "almost done" event was sent for a job
- **WHEN** the printer's estimate moves the remaining time back above 600 seconds and then below it again
- **THEN** no second "almost done" event is sent for that job

#### Scenario: Reconnect after the first layer
- **GIVEN** a "first layer done" event was sent for a job
- **WHEN** the session reconnects and the printer reports the same job on a later layer
- **THEN** no second "first layer done" event is sent

#### Scenario: Next job
- **GIVEN** a "first layer done" event was sent for a job that then finished
- **WHEN** a new job with a different id completes its first layer
- **THEN** a "first layer done" event is sent for the new job

## MODIFIED Requirements

### Requirement: Photos on print Notifications
When photos are turned on, the system SHALL attach a Photo, one still JPEG from the
printer's camera, to the Notifications for the events finished, failed, stopped, paused,
and first layer done. Notifications for started, almost done, offline, and online SHALL
never carry a Photo. Photos SHALL be off by default and SHALL be turned on by one setting
for all five events. The per-event setting SHALL still decide whether an event is sent at
all.

#### Scenario: Photos off by default
- **GIVEN** an ntfy topic is configured and the photo setting is not set
- **WHEN** a print finishes
- **THEN** the "print finished" Notification is sent text-only and the camera is not contacted

#### Scenario: Finished with a Photo
- **GIVEN** photos are on and the camera serves frames
- **WHEN** a print finishes
- **THEN** the "print finished" Notification carries a Photo taken from the camera

#### Scenario: First layer done with a Photo
- **GIVEN** photos are on, the "first layer done" event is enabled, and the camera serves frames
- **WHEN** a print completes its first layer
- **THEN** the "first layer done" Notification carries a Photo taken from the camera

#### Scenario: Started never carries a Photo
- **GIVEN** photos are on and the "print started" event is enabled
- **WHEN** a print starts
- **THEN** the "print started" Notification is sent text-only and the camera is not contacted

#### Scenario: Almost done never carries a Photo
- **GIVEN** photos are on and the "almost done" event is enabled
- **WHEN** a print has ten minutes left
- **THEN** the "almost done" Notification is sent text-only and the camera is not contacted

#### Scenario: Event disabled with photos on
- **GIVEN** photos are on and the "print paused" event is disabled
- **WHEN** a print pauses
- **THEN** no Notification is sent and no Photo is taken
