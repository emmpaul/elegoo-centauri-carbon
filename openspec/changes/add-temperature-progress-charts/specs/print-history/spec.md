# Spec Delta

## MODIFIED Requirements

### Requirement: Archive schema version

The archive SHALL record its schema version in the database file. On start the service
SHALL create the schema in an empty file, open a file at the current version unchanged,
upgrade a file at an older version to the current one keeping every stored job and
thumbnail, and refuse to start on a file whose version is newer than the one it knows.

#### Scenario: New file

- **WHEN** the service opens an empty archive file
- **THEN** the file afterwards reports the current schema version

#### Scenario: File from an older version

- **GIVEN** an archive file at an older schema version holding jobs and thumbnails
- **WHEN** the service starts
- **THEN** the file afterwards reports the current schema version, and the history API returns the same jobs and thumbnails as before

#### Scenario: File from a newer version

- **GIVEN** an archive file whose schema version is higher than the service knows
- **WHEN** the service starts
- **THEN** it exits non-zero with a message naming both versions, and the file is unchanged
