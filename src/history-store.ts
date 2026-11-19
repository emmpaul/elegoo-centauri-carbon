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

/** `TaskStatus` of a job the printer still runs. */
export const TASK_STATUS_RUNNING = 4;

/** One Cmd 321 `HistoryDetailList[]` entry, normalized for the archive (design D3). */
export interface JobRecord {
  taskId: string;
  fileName: string;
  /** Unix seconds; 0 when unknown. */
  beginTime: number;
  /** Unix seconds; 0 when unknown. */
  endTime: number;
  taskStatus: number;
  errorCode: number;
  layersPrinted: number;
  layersTotal: number;
  thumbnailUrl: string | null;
  /** The raw entry as JSON, kept for fields a later feature may need. */
  detail: string;
}

export type JobOutcome = "completed" | "failed" | "stopped" | "running" | "unknown";

/** A stored job as the history API serves it (design D6). */
export interface HistoryJob {
  id: string;
  fileName: string;
  /** Milliseconds since the epoch; null when unknown. */
  startedAt: number | null;
  /** Milliseconds since the epoch; null when unknown or while running. */
  endedAt: number | null;
  /** Wall time from start to end; null when either is unknown or while running. */
  durationSeconds: number | null;
  layers: { printed: number; total: number };
  outcome: JobOutcome;
  taskStatus: number;
  /** `ErrorStatusReason`; null when 0. */
  errorCode: number | null;
  /** API path of the stored thumbnail; null without one. */
  thumbnail: string | null;
}

/**
 * Normalizes one `HistoryDetailList[]` entry, or returns null when it has no
 * non-empty string `TaskId`. Numbers default to 0 when missing or not finite.
 */
export function jobFromDetail(entry: unknown): JobRecord | null {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
  const raw = entry as Record<string, unknown>;
  if (typeof raw.TaskId !== "string" || raw.TaskId === "") return null;
  const slice = typeof raw.SliceInformation === "object" && raw.SliceInformation !== null
    ? (raw.SliceInformation as Record<string, unknown>)
    : {};
  return {
    taskId: raw.TaskId,
    fileName: typeof raw.TaskName === "string" ? (raw.TaskName.split("/").pop() ?? "") : "",
    beginTime: integer(raw.BeginTime),
    endTime: integer(raw.EndTime),
    taskStatus: integer(raw.TaskStatus),
    errorCode: integer(raw.ErrorStatusReason),
    layersPrinted: integer(raw.AlreadyPrintLayer),
    layersTotal: integer(slice.total_layer_numbers),
    thumbnailUrl: typeof raw.Thumbnail === "string" && raw.Thumbnail !== "" ? raw.Thumbnail : null,
    detail: JSON.stringify(entry),
  };
}

/**
 * The outcome of a job (spec: Job outcome), computed on read so a later
 * correction of the code meanings needs no migration. `TaskStatus` 3 reads
 * "stopped" by inference only (docs/sdcp-protocol.md).
 */
export function jobOutcome(taskStatus: number, errorCode: number): JobOutcome {
  if (errorCode !== 0) return "failed";
  switch (taskStatus) {
    case 1:
      return "completed";
    case 3:
      return "stopped";
    case TASK_STATUS_RUNNING:
      return "running";
    default:
      return "unknown";
  }
}

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

  /**
   * Inserts or updates the jobs in one transaction and returns how many rows
   * were inserted or had a changed field (`updated_at` aside).
   */
  upsert(jobs: readonly JobRecord[]): number {
    const statement = this.#db.prepare(
      `INSERT INTO jobs (task_id, file_name, begin_time, end_time, task_status, error_code,
                         layers_printed, layers_total, thumbnail_url, detail, updated_at)
       VALUES (:taskId, :fileName, :beginTime, :endTime, :taskStatus, :errorCode,
               :layersPrinted, :layersTotal, :thumbnailUrl, :detail, :updatedAt)
       ON CONFLICT (task_id) DO UPDATE SET
         file_name = excluded.file_name, begin_time = excluded.begin_time,
         end_time = excluded.end_time, task_status = excluded.task_status,
         error_code = excluded.error_code, layers_printed = excluded.layers_printed,
         layers_total = excluded.layers_total, thumbnail_url = excluded.thumbnail_url,
         detail = excluded.detail, updated_at = excluded.updated_at
       WHERE (file_name, begin_time, end_time, task_status, error_code, layers_printed,
              layers_total, thumbnail_url, detail)
         IS NOT (excluded.file_name, excluded.begin_time, excluded.end_time,
                 excluded.task_status, excluded.error_code, excluded.layers_printed,
                 excluded.layers_total, excluded.thumbnail_url, excluded.detail)`,
    );
    const updatedAt = Date.now();
    let changed = 0;
    this.#transaction(() => {
      for (const job of jobs) {
        changed += Number(statement.run({ ...job, updatedAt }).changes);
      }
    });
    return changed;
  }

  /** The stored job with this id, or null. */
  job(taskId: string): HistoryJob | null {
    const row = this.#db.prepare(`${SELECT_JOB} WHERE task_id = ?`).get(taskId);
    return row === undefined ? null : toHistoryJob(row as unknown as JobRow);
  }

  #transaction(work: () => void): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      work();
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    if (this.#db.isOpen) this.#db.close();
  }
}

class NewerSchemaError extends Error {}

const SELECT_JOB =
  `SELECT task_id, file_name, begin_time, end_time, task_status, error_code,
          layers_printed, layers_total,
          EXISTS (SELECT 1 FROM thumbnails t WHERE t.task_id = jobs.task_id) AS has_thumbnail
   FROM jobs`;

interface JobRow {
  task_id: string;
  file_name: string;
  begin_time: number;
  end_time: number;
  task_status: number;
  error_code: number;
  layers_printed: number;
  layers_total: number;
  has_thumbnail: number;
}

function toHistoryJob(row: JobRow): HistoryJob {
  const outcome = jobOutcome(row.task_status, row.error_code);
  const running = outcome === "running";
  const known = row.begin_time !== 0 && row.end_time !== 0;
  return {
    id: row.task_id,
    fileName: row.file_name,
    startedAt: row.begin_time === 0 ? null : row.begin_time * 1000,
    endedAt: running || row.end_time === 0 ? null : row.end_time * 1000,
    durationSeconds: running || !known ? null : row.end_time - row.begin_time,
    layers: { printed: row.layers_printed, total: row.layers_total },
    outcome,
    taskStatus: row.task_status,
    errorCode: row.error_code === 0 ? null : row.error_code,
    thumbnail: row.has_thumbnail ? `/api/history/thumbnail?id=${encodeURIComponent(row.task_id)}` : null,
  };
}

function integer(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : 0;
}

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
