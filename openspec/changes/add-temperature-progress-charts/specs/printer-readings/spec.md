# Spec Delta

## Purpose

Records the printer's measured values over time as Readings, groups a job's Readings into
its Trace, keeps them in the archive within bounds, and serves them to the dashboard and
API clients.

## ADDED Requirements

### Requirement: Readings recorded every ten seconds

While the session to the printer is online, the service SHALL record one Reading every 10
seconds from the latest snapshot. A Reading SHALL hold its time and:
- the nozzle, bed, and chamber temperatures, with the nozzle and bed targets;
- progress percent and current layer;
- print speed percent and the part, auxiliary, and chamber fan speeds;
- Z height;
- the machine and print state;
- the light state.

A value the printer has not reported SHALL be null.

#### Scenario: Steady recording

- **GIVEN** the printer is online and pushes status about every 3 seconds
- **WHEN** one minute passes
- **THEN** six Readings are recorded, ten seconds apart, each with the latest pushed values

#### Scenario: Bursts do not add Readings

- **GIVEN** the printer is online
- **WHEN** it sends a burst of status pushes 130 ms apart during a state change
- **THEN** no more than one Reading is recorded in any 10-second interval

### Requirement: No Readings while offline

The service SHALL NOT record a Reading while the session to the printer is not online,
so the time without contact stays a gap. It SHALL resume recording on the 10-second
cadence once the session is online again.

#### Scenario: Printer goes offline

- **GIVEN** the printer is online and Readings are being recorded
- **WHEN** the session is lost for 5 minutes and then comes back
- **THEN** no Reading is recorded during those 5 minutes, and recording resumes after the session is back

### Requirement: Trace bounds

A Reading SHALL belong to a job's Trace when it carries that job's id, and also for the
15 minutes after the job ends. The Trace SHALL start at the job's first Reading, heat-up
included. A Reading taken neither during a job nor in those 15 minutes SHALL belong to
no Trace.

#### Scenario: Heat-up included

- **GIVEN** a job whose id the printer reports while it is still heating
- **WHEN** its Trace is read
- **THEN** it starts at the first Reading that carried that id, before printing began

#### Scenario: Cool-down tail

- **GIVEN** a job that ended at 21:00, after which the printer reports no job id
- **WHEN** Readings are recorded until 21:30
- **THEN** the Readings up to 21:15 belong to the job's Trace and the later ones belong to no Trace

#### Scenario: Next job starts during the tail

- **GIVEN** a job ended at 21:00
- **WHEN** a new job with another id starts at 21:05
- **THEN** Readings from 21:05 belong to the new job's Trace, and the first job's Trace ends at its last Reading before 21:05

### Requirement: Partial Traces

A Trace SHALL be marked partial when Readings are missing between its first and last
Reading because the service was not running or the printer was offline.

#### Scenario: Service restarted mid-job

- **GIVEN** a job is printing
- **WHEN** the service stops for 10 minutes and starts again before the job ends
- **THEN** the job's Trace is marked partial and holds the Readings from before and after the stop

#### Scenario: Complete Trace

- **GIVEN** a job whose Readings follow each other with no interval longer than 30 seconds
- **WHEN** its Trace is read
- **THEN** it is not marked partial

### Requirement: Readings kept across restarts

The service SHALL store Readings in the archive, so the recent Readings and every kept
Trace are still served after the service restarts.

#### Scenario: Restart keeps the window

- **GIVEN** Readings were recorded over the last 2 hours
- **WHEN** the service restarts and a client asks for the last 3 hours of Readings
- **THEN** the Readings recorded before the restart are returned

### Requirement: Retention of Readings outside a Trace

The service SHALL delete Readings that belong to no Trace once they are older than 24
hours.

#### Scenario: Idle day

- **GIVEN** the printer stayed idle and online for 30 hours
- **WHEN** the service prunes Readings
- **THEN** only the Readings of the last 24 hours remain

### Requirement: Retention of Traces

Traces SHALL be kept as long as their job, under a cap on the total number of stored
Readings. Over the cap, the service SHALL delete whole Traces, those of the jobs with
the oldest start first, never the Trace of a job still running. A job SHALL stay in the
archive without its Trace.

#### Scenario: Cap reached

- **GIVEN** the stored Readings exceed the cap
- **WHEN** the service prunes Readings
- **THEN** the Traces of the oldest jobs are deleted whole until the total is under the cap, and those jobs are still listed by the history API

### Requirement: Readings API

`GET /api/readings?since=<ms>` SHALL answer the stored Readings recorded at or after
`since` (milliseconds since the Unix epoch), oldest first, at most the last 24 hours.
Without `since` it SHALL answer the last 3 hours. A `since` that is not a whole number
SHALL answer 400 `bad-request`.

#### Scenario: Window requested

- **GIVEN** Readings stored over the last 5 hours
- **WHEN** a client requests `/api/readings?since=<one hour ago>`
- **THEN** it receives the Readings of the last hour, oldest first

#### Scenario: Invalid since

- **WHEN** a client requests `/api/readings?since=yesterday`
- **THEN** the service answers 400 with error `bad-request`

### Requirement: Trace API

`GET /api/history/trace?id=<taskId>` SHALL answer the job's Trace (its Readings, oldest
first) and whether it is partial. It SHALL answer 404 `not-found` when no Trace is stored
for that id, and 400 `bad-request` when `id` is missing or empty.

#### Scenario: Stored Trace

- **GIVEN** a stored job with a Trace
- **WHEN** a client requests its trace by id
- **THEN** it receives the Trace's Readings oldest first and its partial flag

#### Scenario: Trace deleted by the cap

- **GIVEN** a stored job whose Trace was deleted to stay under the cap
- **WHEN** a client requests its trace
- **THEN** the service answers 404 with error `not-found`

### Requirement: Reading event

The event stream SHALL send a `reading` event carrying each new Reading as it is
recorded.

#### Scenario: Live Reading

- **GIVEN** a client is connected to `/api/events` and the printer is online
- **WHEN** the service records a Reading
- **THEN** the client receives an event named `reading` with that Reading

### Requirement: Readings behind the access token

When an access token is configured, the readings and trace routes SHALL require it in the
same ways as the other API routes (bearer header or `token` query parameter), and SHALL
answer 401 `unauthorized` without it.

#### Scenario: No token

- **GIVEN** an access token is configured
- **WHEN** a client requests `/api/readings` without it
- **THEN** the service answers 401 with error `unauthorized`
