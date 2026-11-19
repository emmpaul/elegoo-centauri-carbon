# Spec Delta

## Purpose

Keeps a lasting archive of the printer's past print jobs, synced from the printer's own
job history, and serves it read-only to the dashboard and API clients, also while the
printer is offline.

## ADDED Requirements

### Requirement: Data directory

The service SHALL keep the archive in one database file inside a data directory set by
the `dataDir` config key or the `DATA_DIR` environment variable (the variable wins), by
default `./data` relative to the working directory. It SHALL create the directory when it
is missing. When the directory or the file cannot be created, opened, or written, the
service SHALL refuse to start with a message naming the path and the setting.

#### Scenario: Default location

- **GIVEN** neither `dataDir` nor `DATA_DIR` is set and `./data` does not exist
- **WHEN** the service starts
- **THEN** it creates `./data` and the archive file in it

#### Scenario: Environment wins over the file

- **GIVEN** the config file sets `dataDir` to one directory and `DATA_DIR` names another
- **WHEN** the config is loaded
- **THEN** the data directory is the one `DATA_DIR` names

#### Scenario: Unwritable directory

- **GIVEN** the data directory exists and the service user cannot write to it
- **WHEN** the service starts
- **THEN** it exits non-zero with a message that names the directory and `DATA_DIR`, before listening

### Requirement: Archive schema version

The archive SHALL record its schema version in the database file. On start the service
SHALL create the schema in an empty file, open a file at the current version unchanged,
and refuse to start on a file whose version is newer than the one it knows.

#### Scenario: New file

- **WHEN** the service opens an empty archive file
- **THEN** the file afterwards reports the current schema version

#### Scenario: File from a newer version

- **GIVEN** an archive file whose schema version is higher than the service knows
- **WHEN** the service starts
- **THEN** it exits non-zero with a message naming both versions, and the file is unchanged

### Requirement: Sync from the printer

Each time the session to the printer comes online, and each time a job ends (finished,
failed, or stopped), the service SHALL request the printer's history ids (Cmd 320) and
then the details (Cmd 321) of every listed id that the archive does not hold yet or holds
as running. It SHALL NOT send any other command for history, and SHALL run at most one
sync at a time.

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

### Requirement: Jobs kept after the printer drops them

The archive SHALL keep every job it has stored, also after the printer's history no
longer lists it, and SHALL serve the stored jobs while the printer is offline. A sync
SHALL add or update jobs but never delete them.

#### Scenario: Printer trims its list

- **GIVEN** the archive holds a job the printer's history no longer lists
- **WHEN** a sync runs
- **THEN** the job is still in the archive and in the history API

#### Scenario: Printer offline

- **GIVEN** the archive holds jobs and the printer is unreachable
- **WHEN** a client requests the history
- **THEN** the stored jobs are returned

### Requirement: Sync failures are contained

A sync that fails (no session, a timeout, a non-zero `Ack`, or a malformed answer) SHALL
be logged as a warning, leave the archive as it was before that sync, and leave the
printer session, status, and events unaffected. Entries without a `TaskId` SHALL be
skipped.

#### Scenario: History request times out

- **GIVEN** the printer does not answer Cmd 320
- **WHEN** a sync runs
- **THEN** a warning is logged, the archive is unchanged, and the session stays online

#### Scenario: Malformed entry

- **GIVEN** a Cmd 321 answer in which one entry has no `TaskId`
- **WHEN** it is stored
- **THEN** that entry is skipped and the other entries are stored

### Requirement: Job outcome

Each stored job SHALL carry an outcome derived from its details: `failed` when its
`ErrorStatusReason` is non-zero, else `completed` for `TaskStatus` 1, `stopped` for 3,
`running` for 4, and `unknown` for any other value. The raw `TaskStatus` and the error
code SHALL be kept with it.

#### Scenario: Stopped job

- **GIVEN** a task detail with `TaskStatus` 3, `AlreadyPrintLayer` 16, and 19 total layers
- **WHEN** it is stored
- **THEN** the job's outcome is `stopped` with 16 of 19 layers printed

#### Scenario: Failed job

- **GIVEN** a task detail with `TaskStatus` 1 and `ErrorStatusReason` 45
- **WHEN** it is stored
- **THEN** the job's outcome is `failed` with error code 45

### Requirement: Thumbnails stored with limits

The service SHALL fetch each stored job's thumbnail once, store its bytes in the archive,
and serve it from there. It SHALL accept only `image/png` or `image/jpeg` answers of at
most 1 MiB, give up on a job's thumbnail after 3 failed attempts, and keep the stored
thumbnails at most 100 MiB in total by dropping the oldest jobs' thumbnails first. The
job itself SHALL stay in the archive without its thumbnail.

#### Scenario: Thumbnail fetched once

- **GIVEN** a stored job whose thumbnail has been fetched
- **WHEN** later syncs run and clients request the thumbnail
- **THEN** the printer is not asked for that thumbnail again

#### Scenario: Oversized thumbnail

- **WHEN** the printer answers a thumbnail request with more than 1 MiB
- **THEN** nothing is stored for it and the attempt counts as failed

#### Scenario: Total limit reached

- **GIVEN** storing a new thumbnail would take the total over 100 MiB
- **WHEN** it is stored
- **THEN** the thumbnails of the oldest jobs are removed until the total fits, and those jobs stay listed without a thumbnail

### Requirement: Thumbnails only from the printer

The service SHALL fetch a thumbnail only when its URL uses `http` and its host is the
printer's address, with a 10 second time limit. Any other URL SHALL be ignored and the
job stored without a thumbnail.

#### Scenario: Foreign host

- **GIVEN** a task detail whose `Thumbnail` names a host other than the printer
- **WHEN** it is stored
- **THEN** no request is made to that host and the job has no thumbnail

### Requirement: History list API

`GET /api/history` SHALL answer the stored jobs newest first by start time, at most
`limit` per page (default 20, 1 to 100), with a `next` cursor for the following page or
null on the last one. Passing that cursor as `before` SHALL return the page after it. A
`limit` or `before` that is not valid SHALL answer 400 `bad-request`.

#### Scenario: First page

- **GIVEN** 26 stored jobs
- **WHEN** a client requests `GET /api/history?limit=20`
- **THEN** it gets the 20 newest jobs and a non-null `next`

#### Scenario: Last page

- **GIVEN** 26 stored jobs and the `next` cursor of the first page of 20
- **WHEN** a client requests `GET /api/history?limit=20&before=<next>`
- **THEN** it gets the remaining 6 jobs and `next` is null

#### Scenario: Invalid limit

- **WHEN** a client requests `GET /api/history?limit=0`
- **THEN** the answer is 400 with error code `bad-request`

#### Scenario: Job fields

- **WHEN** a job is listed
- **THEN** it has its id, file name, start and end time (null when unknown), duration in seconds (null while running), layers printed and total, outcome, raw task status, error code (null when 0), and a thumbnail path or null

### Requirement: Thumbnail API

`GET /api/history/thumbnail?id=<taskId>` SHALL answer the stored thumbnail bytes with
their stored content type, and 404 `not-found` when the job or its thumbnail is not
stored. It SHALL never contact the printer.

#### Scenario: Stored thumbnail

- **GIVEN** a stored job with a stored PNG thumbnail
- **WHEN** a client requests its thumbnail
- **THEN** the answer is 200 `image/png` with the stored bytes

#### Scenario: Missing thumbnail

- **WHEN** a client requests the thumbnail of an id the archive does not hold
- **THEN** the answer is 404 with error code `not-found`

### Requirement: History behind the access token

When an access token is configured, both history routes SHALL require it in the same
ways as the other API routes (bearer header or `token` query parameter), and answer 401
`unauthorized` without it. Both routes SHALL accept only GET.

#### Scenario: No token

- **GIVEN** the service has an access token
- **WHEN** a client requests `GET /api/history` without it
- **THEN** the answer is 401 with error code `unauthorized`

#### Scenario: Write attempt

- **WHEN** a client sends `POST /api/history`
- **THEN** the answer is 405 with error code `method-not-allowed`

### Requirement: History change event

The event stream SHALL send a `history` event each time a sync adds or changes a stored
job or stores a thumbnail, and SHALL NOT send one for a sync that changes nothing.

#### Scenario: Job added

- **GIVEN** a client is connected to `/api/events`
- **WHEN** a sync stores a new job
- **THEN** the client receives an event named `history`

#### Scenario: Nothing new

- **GIVEN** a client is connected to `/api/events`
- **WHEN** a sync finds nothing to add or change
- **THEN** the client receives no `history` event
