// The print history archive (design D1): one SQLite file through Node's
// built-in `node:sqlite`, owned by this module alone, so the sync, the API,
// and later features read jobs through it.
import { DatabaseSync } from "node:sqlite";

/**
 * Schema steps in order: `MIGRATIONS[n]` takes a file from version n to n+1.
 * The schema version of a file is its `PRAGMA user_version`.
 */
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE jobs (
     task_id TEXT PRIMARY KEY,
     file_name TEXT NOT NULL,
     begin_time INTEGER NOT NULL,
     end_time INTEGER NOT NULL,
     task_status INTEGER NOT NULL,
     error_code INTEGER NOT NULL,
     layers_printed INTEGER NOT NULL,
     layers_total INTEGER NOT NULL,
     thumbnail_url TEXT,
     thumbnail_attempts INTEGER NOT NULL DEFAULT 0,
     detail TEXT NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE INDEX jobs_newest ON jobs (begin_time DESC, task_id DESC);
   CREATE TABLE thumbnails (
     task_id TEXT PRIMARY KEY REFERENCES jobs ON DELETE CASCADE,
     content_type TEXT NOT NULL,
     bytes BLOB NOT NULL,
     size INTEGER NOT NULL
   );`,
];

/** The schema version this code writes and reads. */
export const SCHEMA_VERSION = MIGRATIONS.length;

export class HistoryStore {
  readonly #db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.#db = db;
  }

  /**
   * Opens (creating when missing) the archive at `path`, which may be
   * `:memory:`, and brings its schema to {@link SCHEMA_VERSION}. Throws when
   * the file cannot be opened or written, or when its schema is newer than
   * this code knows; a newer file is left unchanged.
   */
  static open(path: string): HistoryStore {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(path);
      const version = userVersion(db);
      if (version > SCHEMA_VERSION) {
        throw new NewerSchemaError(
          `the history archive at ${path} has schema version ${version}, ` +
            `newer than version ${SCHEMA_VERSION} that this service knows: ` +
            `run a newer release or set DATA_DIR or dataDir to another directory`,
        );
      }
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA foreign_keys = ON");
      // A read-only file or directory fails here, at start-up, and not on the first write.
      db.exec("BEGIN IMMEDIATE; COMMIT");
      migrate(db, version);
      return new HistoryStore(db);
    } catch (error) {
      db?.close();
      if (error instanceof NewerSchemaError) throw error;
      throw new Error(
        `cannot open the history archive at ${path} ` +
          `(set DATA_DIR or dataDir to a writable directory): ${(error as Error).message}`,
        { cause: error },
      );
    }
  }

  /** The schema version recorded in the open file. */
  schemaVersion(): number {
    return userVersion(this.#db);
  }

  close(): void {
    if (this.#db.isOpen) this.#db.close();
  }
}

class NewerSchemaError extends Error {}

function userVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  return row.user_version;
}

/** Runs each missing step in its own transaction together with its version bump. */
function migrate(db: DatabaseSync, from: number): void {
  for (let version = from; version < SCHEMA_VERSION; version++) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(MIGRATIONS[version]!);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}
