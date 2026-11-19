## MODIFIED Requirements

### Requirement: Sync from the printer

Each time the session to the printer comes online, and each time a job ends (finished,
failed, or stopped), the service SHALL request the printer's history ids (Cmd 320) and
then the details (Cmd 321) of every listed id that the archive does not hold yet or holds
as running. It SHALL NOT send any other command for history, and SHALL run at most one
sync at a time. When a sync leaves a listed job stored as running while no print is
active, the service SHALL run one more sync after 10 seconds, at most 3 such follow-up
syncs in a row; the next trigger starts a new run of follow-ups.

#### Scenario: First connect

- **GIVEN** an empty archive and a printer whose history lists 26 jobs
- **WHEN** the session comes online
- **THEN** the archive holds those 26 jobs with the details the printer reported

#### Scenario: Only new and running jobs are requested

- **GIVEN** the archive holds every listed job, one of them as running
- **WHEN** the session comes online again
- **THEN** the Cmd 321 request lists only the running job's id

#### Scenario: Job end

- **WHEN** a job's end is detected
- **THEN** the service syncs, and the ended job is stored with its end time and outcome

#### Scenario: Overlapping triggers

- **GIVEN** a sync is in progress
- **WHEN** another trigger arrives
- **THEN** no second sync runs at the same time, and one more sync runs after the current one ends

#### Scenario: Ended job still reported as running

- **GIVEN** no print is active and the printer still reports the ended job as running
- **WHEN** a sync stores it as running
- **THEN** the service syncs again after 10 seconds, at most 3 times in a row, and stops once the job is stored with its outcome

#### Scenario: No follow-up during a print

- **GIVEN** a print is active
- **WHEN** a sync stores a job as running
- **THEN** no follow-up sync is scheduled

### Requirement: Sync failures are contained

A sync that fails (no session, a timeout, a non-zero `Ack`, or a malformed answer) SHALL
be logged as one warning and leave the printer session, status, and events unaffected.
Jobs stored by that sync before the failure SHALL stay stored, and nothing SHALL be
stored from the failed request. Entries without a `TaskId` SHALL be skipped.

#### Scenario: History request times out

- **GIVEN** the printer does not answer Cmd 320
- **WHEN** a sync runs
- **THEN** a warning is logged, the archive is unchanged, and the session stays online

#### Scenario: Later detail request fails

- **GIVEN** a sync needs two Cmd 321 requests, and the printer answers the first and not the second
- **WHEN** the sync runs
- **THEN** the jobs from the first answer are stored, a warning is logged, and the next sync requests only the jobs still missing

#### Scenario: Malformed entry

- **GIVEN** a Cmd 321 answer in which one entry has no `TaskId`
- **WHEN** it is stored
- **THEN** that entry is skipped and the other entries are stored

### Requirement: Thumbnail API

`GET /api/history/thumbnail?id=<taskId>` SHALL answer the stored thumbnail bytes with
their stored content type, 404 `not-found` when the job or its thumbnail is not stored,
and 400 `bad-request` when `id` is missing or empty. It SHALL never contact the printer.

#### Scenario: Stored thumbnail

- **GIVEN** a stored job with a stored PNG thumbnail
- **WHEN** a client requests its thumbnail
- **THEN** the answer is 200 `image/png` with the stored bytes

#### Scenario: Missing thumbnail

- **WHEN** a client requests the thumbnail of an id the archive does not hold
- **THEN** the answer is 404 with error code `not-found`

#### Scenario: No id

- **WHEN** a client requests `/api/history/thumbnail` without `id`, or with an empty `id`
- **THEN** the answer is 400 with error code `bad-request`
