## MODIFIED Requirements

### Requirement: History refresh and empty states

While open, the History section SHALL reload its first page when the event stream sends
a `history` event, and when the dashboard reconnects to the service after losing it,
since `history` events may have been missed. A closed section SHALL load fresh on its
next open. It SHALL show "No prints yet" when the archive is empty, and a failed load
SHALL show an inline message with a Retry button without affecting the status view; a
failed list SHALL also be loaded again once the service answers again.

#### Scenario: Job ends while open

- **GIVEN** the History section is open
- **WHEN** the event stream sends a `history` event
- **THEN** the list is reloaded from its first page and shows the new job at the top

#### Scenario: Reconnect while open

- **GIVEN** the History section is open and the service connection was lost
- **WHEN** the dashboard connects to the service again
- **THEN** the list is reloaded from its first page

#### Scenario: Empty archive

- **GIVEN** the history API answers no jobs
- **WHEN** the user opens the History section
- **THEN** it shows "No prints yet"

#### Scenario: Load fails

- **GIVEN** the history API answers 500
- **WHEN** the user opens the History section
- **THEN** it shows "History unavailable" with a Retry button, and the status sheet keeps updating
