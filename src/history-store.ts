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

/** Default cap on the stored thumbnails' total size (design D5). */
export const THUMBNAIL_TOTAL_BYTES = 100 * 1024 * 1024;

/**
 * `thumbnail_attempts` of a job whose thumbnail was dropped to keep the total
 * under its cap: above any attempt limit, so it is not fetched again.
 */
const THUMBNAIL_DROPPED = 1_000_000;

export interface HistoryStoreOptions {
  /** Cap on the total size of the stored thumbnails; the oldest jobs' go first. */
  thumbnailTotalBytes?: number;
}

/** A stored thumbnail. */
export interface Thumbnail {
  contentType: string;
  bytes: Uint8Array;
}

/** A job whose thumbnail is still to fetch. */
export interface ThumbnailRequest {
  taskId: string;
  url: string;
}

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

/** One page of the history, newest first, and the cursor of the next page or null on the last. */
export interface HistoryPage {
  jobs: HistoryJob[];
  next: string | null;
}

/** Position in the history: the start time (Unix seconds) and id of the last job of a page. */
export interface HistoryCursor {
  beginTime: number;
  taskId: string;
}

/** A task id written into a cursor as it is; any other id is written as `~` and its base64url. */
const PLAIN_TASK_ID = /^[A-Za-z0-9-]{1,64}$/;
const ENCODED_TASK_ID = /^~([A-Za-z0-9_-]+)$/;

/**
 * Encodes a cursor as `<beginTime>_<taskId>`; clients treat it as opaque. An
 * id outside letters, digits, and dashes (or over 64 characters) is written
 * as `~<base64url>`, so every cursor parses back to the same position.
 */
export function encodeHistoryCursor(cursor: HistoryCursor): string {
  const id = PLAIN_TASK_ID.test(cursor.taskId)
    ? cursor.taskId
    : `~${Buffer.from(cursor.taskId, "utf8").toString("base64url")}`;
  return `${String(cursor.beginTime)}_${id}`;
}

/** Parses a cursor made by {@link encodeHistoryCursor}, or returns null for any other text. */
export function parseHistoryCursor(text: string): HistoryCursor | null {
  const split = text.indexOf("_");
  if (split < 1) return null;
  const time = text.slice(0, split);
  const id = text.slice(split + 1);
  const beginTime = Number(time);
  // Only the form encodeHistoryCursor writes: no "+1", "01", "1e3", or " 1".
  if (!Number.isInteger(beginTime) || String(beginTime) !== time) return null;
  let taskId: string;
  if (PLAIN_TASK_ID.test(id)) {
    taskId = id;
  } else {
    const encoded = ENCODED_TASK_ID.exec(id)?.[1];
    if (encoded === undefined) return null;
    taskId = Buffer.from(encoded, "base64url").toString("utf8");
  }
  const cursor = { beginTime, taskId };
  // Rejects base64url that does not decode to UTF-8 text the encoder would write back the same way.
  return taskId !== "" && encodeHistoryCursor(cursor) === text ? cursor : null;
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
  readonly #thumbnailTotalBytes: number;

  private constructor(db: DatabaseSync, thumbnailTotalBytes: number) {
    this.#db = db;
    this.#thumbnailTotalBytes = thumbnailTotalBytes;
  }

  /**
   * Opens (creating when missing) the archive at `path`, which may be
   * `:memory:`, and brings its schema to {@link SCHEMA_VERSION}. Throws when
   * the file cannot be opened or written, or when its schema is newer than
   * this code knows; a newer file is left unchanged.
   */
  static open(path: string, options: HistoryStoreOptions = {}): HistoryStore {
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
      return new HistoryStore(db, options.thumbnailTotalBytes ?? THUMBNAIL_TOTAL_BYTES);
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

  /**
   * At most `limit` stored jobs, newest first by start time then id, that come
   * after the cursor `before` (all jobs from the newest when null). Throws a
   * RangeError for a malformed cursor or a limit that is not a positive integer.
   */
  list(before: string | null, limit: number): HistoryPage {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError(`invalid history page limit: ${limit}`);
    const cursor = before === null ? null : parseHistoryCursor(before);
    if (before !== null && cursor === null) throw new RangeError(`invalid history cursor: ${before}`);
    const order = "ORDER BY begin_time DESC, task_id DESC LIMIT ?";
    const rows = (
      cursor === null
        ? this.#db.prepare(`${SELECT_JOB} ${order}`).all(limit + 1)
        : this.#db
            .prepare(`${SELECT_JOB} WHERE (begin_time, task_id) < (?, ?) ${order}`)
            .all(cursor.beginTime, cursor.taskId, limit + 1)
    ) as unknown as JobRow[];
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      jobs: page.map(toHistoryJob),
      next: rows.length > limit && last !== undefined
        ? encodeHistoryCursor({ beginTime: last.begin_time, taskId: last.task_id })
        : null,
    };
  }

  /**
   * Stores a job's thumbnail, then drops the thumbnails of the jobs with the
   * oldest start time while the total is over the cap. A dropped thumbnail's
   * job stays listed, without a thumbnail, and is not fetched again.
   */
  putThumbnail(taskId: string, contentType: string, bytes: Uint8Array): void {
    this.#transaction(() => {
      this.#db
        .prepare("INSERT OR REPLACE INTO thumbnails (task_id, content_type, bytes, size) VALUES (?, ?, ?, ?)")
        .run(taskId, contentType, bytes, bytes.byteLength);
      const total = this.#db.prepare("SELECT COALESCE(SUM(size), 0) AS total FROM thumbnails");
      const oldest = this.#db.prepare(
        `SELECT t.task_id, t.size FROM thumbnails t JOIN jobs j ON j.task_id = t.task_id
         ORDER BY j.begin_time ASC, j.task_id ASC LIMIT 1`,
      );
      const drop = this.#db.prepare("DELETE FROM thumbnails WHERE task_id = ?");
      const markDropped = this.#db.prepare("UPDATE jobs SET thumbnail_attempts = ? WHERE task_id = ?");
      let sum = (total.get() as { total: number }).total;
      while (sum > this.#thumbnailTotalBytes) {
        const row = oldest.get() as { task_id: string; size: number } | undefined;
        if (row === undefined) break;
        drop.run(row.task_id);
        markDropped.run(THUMBNAIL_DROPPED, row.task_id);
        sum -= row.size;
      }
    });
  }

  /** The stored thumbnail of a job, or null. */
  thumbnail(taskId: string): Thumbnail | null {
    const row = this.#db.prepare("SELECT content_type, bytes FROM thumbnails WHERE task_id = ?").get(taskId) as
      | { content_type: string; bytes: Uint8Array }
      | undefined;
    return row === undefined ? null : { contentType: row.content_type, bytes: row.bytes };
  }

  /**
   * Jobs, newest first, that have a thumbnail URL but no stored thumbnail and
   * fewer than `maxAttempts` failed fetches.
   */
  jobsNeedingThumbnail(maxAttempts: number): ThumbnailRequest[] {
    const rows = this.#db
      .prepare(
        `SELECT task_id, thumbnail_url FROM jobs
         WHERE thumbnail_url IS NOT NULL AND thumbnail_attempts < ?
           AND NOT EXISTS (SELECT 1 FROM thumbnails t WHERE t.task_id = jobs.task_id)
         ORDER BY begin_time DESC, task_id DESC`,
      )
      .all(maxAttempts) as unknown as { task_id: string; thumbnail_url: string }[];
    return rows.map((row) => ({ taskId: row.task_id, url: row.thumbnail_url }));
  }

  /** Counts one failed thumbnail fetch for a job. */
  recordThumbnailFailure(taskId: string): void {
    this.#db.prepare("UPDATE jobs SET thumbnail_attempts = thumbnail_attempts + 1 WHERE task_id = ?").run(taskId);
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
