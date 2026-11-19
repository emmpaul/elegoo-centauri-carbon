# Spec Delta

## Purpose

Tells the user, through push notifications, when something important happens
to a print: it finishes, fails, pauses, or the printer goes offline. The user
doesn't have to keep the dashboard open.

## ADDED Requirements

### Requirement: Lifecycle event detection
The system SHALL detect these events from changes in the status snapshot:
print started, print finished, print failed or errored, print paused, print
stopped, printer offline, and printer back online.

#### Scenario: Print finishes
- **WHEN** the print state moves from running to completed
- **THEN** the system emits a "print finished" event with the file name and total duration

#### Scenario: Print error
- **WHEN** the printer reports an error or failed print state
- **THEN** the system emits a "print failed" event with the file name, progress percent, and the raw error code

### Requirement: Push delivery
The system SHALL deliver each enabled event as a push notification through the
configured channel. Delivery SHALL go through ntfy by default. Each event type
SHALL be able to be turned on or off.

#### Scenario: Finish notification delivered
- **GIVEN** the "print finished" event is enabled and an ntfy topic is configured
- **WHEN** a print finishes
- **THEN** a notification with the file name and duration is published to that topic

#### Scenario: Event disabled
- **GIVEN** the "print started" event is disabled
- **WHEN** a print starts
- **THEN** no notification is sent

### Requirement: No duplicate notifications
The system SHALL send at most one notification per event occurrence. This
includes the case where status messages repeat or the session reconnects.

#### Scenario: Reconnect during finished state
- **GIVEN** a "print finished" notification was already sent for a job
- **WHEN** the session reconnects and the printer still reports that job as completed
- **THEN** no second notification is sent

### Requirement: Offline debounce
The system SHALL send a "printer offline" notification only after the printer
has been unreachable for 2 minutes in a row.

#### Scenario: Brief network blip
- **WHEN** the session drops and is restored within 2 minutes
- **THEN** no offline notification is sent

### Requirement: Delivery failure handling
When a notification fails to deliver, the system SHALL retry up to 3 times
with back-off, then log the failure. A delivery failure SHALL NOT affect the
printer session.

#### Scenario: ntfy unreachable
- **WHEN** the notification endpoint cannot be reached
- **THEN** the system retries 3 times, logs the failure, and keeps monitoring the printer
