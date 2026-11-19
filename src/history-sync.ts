// Fills the history archive from the printer's own job history (design D4):
// Cmd 320 for the ids, then Cmd 321 for the ids the archive lacks or holds as
// running. It sends nothing else for history, runs one sync at a time, and a
// failed sync only logs a warning: the session, status, and events never see it.
// Thumbnails are fetched over HTTP from the printer's own host only (design D5).
import { EventEmitter } from "node:events";
import { type HistoryStore, jobFromDetail, type JobRecord, TASK_STATUS_RUNNING } from "./history-store.ts";
import { Cmd, type Logger, type SdcpResponse } from "./sdcp-client.ts";

/** The ids one Cmd 321 asks for at most: the size the printer's web UI sends. */
export const DETAIL_CHUNK_SIZE = 26;

/** Largest thumbnail stored (design D5). */
export const THUMBNAIL_MAX_BYTES = 1024 * 1024;
/** Time limit of one thumbnail request. */
export const THUMBNAIL_TIMEOUT_MS = 10_000;
/** Failed fetches after which a job's thumbnail is no longer tried. */
export const THUMBNAIL_MAX_ATTEMPTS = 3;

const THUMBNAIL_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg"]);

/** What the sync needs of the printer session. */
export interface HistorySession {
  send(cmd: number, data?: Record<string, unknown>): Promise<SdcpResponse>;
}

export interface HistorySyncOptions {
  session: HistorySession;
  store: HistoryStore;
  /** Hostname of the printer; thumbnails are fetched only from it. */
  printerHost: string;
  logger?: Logger;
  /** `fetch` for thumbnails; the global one by default. */
  fetch?: typeof fetch;
  thumbnailMaxBytes?: number;
  thumbnailTimeoutMs?: number;
  thumbnailMaxAttempts?: number;
}

type SyncEvents = {
  /** Once per sync that stored something. */
  change: [];
};

export class HistorySync extends EventEmitter<SyncEvents> {
  readonly #session: HistorySession;
  readonly #store: HistoryStore;
  readonly #logger: Logger;
  readonly #printerHost: string;
  readonly #fetch: typeof fetch;
  readonly #thumbnailMaxBytes: number;
  readonly #thumbnailTimeoutMs: number;
  readonly #thumbnailMaxAttempts: number;
  readonly #abort = new AbortController();
  #running: Promise<void> | null = null;
  #again = false;
  #closed = false;

  constructor(options: HistorySyncOptions) {
    super();
    this.#session = options.session;
    this.#store = options.store;
    this.#logger = options.logger ?? console;
    this.#printerHost = options.printerHost;
    this.#fetch = options.fetch ?? fetch;
    this.#thumbnailMaxBytes = options.thumbnailMaxBytes ?? THUMBNAIL_MAX_BYTES;
    this.#thumbnailTimeoutMs = options.thumbnailTimeoutMs ?? THUMBNAIL_TIMEOUT_MS;
    this.#thumbnailMaxAttempts = options.thumbnailMaxAttempts ?? THUMBNAIL_MAX_ATTEMPTS;
  }

  /**
   * Starts a sync, or, while one runs, makes exactly one more run after it
   * (spec: Overlapping triggers).
   */
  trigger(): void {
    if (this.#closed) return;
    if (this.#running !== null) {
      this.#again = true;
      return;
    }
    this.#running = this.#loop();
  }

  /** Resolves once no sync is running or queued. */
  async idle(): Promise<void> {
    while (this.#running !== null) await this.#running;
  }

  /** Stops starting syncs; a running one ends without storing more. */
  close(): void {
    this.#closed = true;
    this.#again = false;
    this.#abort.abort();
  }

  async #loop(): Promise<void> {
    try {
      do {
        this.#again = false;
        await this.#syncOnce();
      } while (this.#again && !this.#closed);
    } finally {
      this.#running = null;
    }
  }

  async #syncOnce(): Promise<void> {
    let changed = 0;
    try {
      const ids = historyIds(await this.#request(Cmd.GET_PRINTER_HISTORY_ID, {}));
      const wanted = ids.filter((id) => {
        const job = this.#store.job(id);
        return job === null || job.taskStatus === TASK_STATUS_RUNNING;
      });
      for (let start = 0; start < wanted.length && !this.#closed; start += DETAIL_CHUNK_SIZE) {
        const chunk = wanted.slice(start, start + DETAIL_CHUNK_SIZE);
        const jobs = detailJobs(await this.#request(Cmd.GET_PRINTER_TASK_DETAIL, { Id: chunk }));
        if (this.#closed) break;
        changed += this.#store.upsert(jobs);
      }
      changed += await this.#fetchThumbnails();
    } catch (error) {
      if (!this.#closed) this.#logger.warn(`history sync failed: ${(error as Error).message}`);
    }
    if (changed > 0 && !this.#closed) this.emit("change");
  }

  /**
   * Fetches the missing thumbnails one at a time and returns how many were
   * stored. Each failure is counted against its job and logged; it does not
   * end the sync.
   */
  async #fetchThumbnails(): Promise<number> {
    let stored = 0;
    for (const { taskId, url } of this.#store.jobsNeedingThumbnail(this.#thumbnailMaxAttempts)) {
      if (this.#closed) break;
      if (!this.#fromPrinter(url)) {
        // Not the printer's host: never requested, and given up on after the attempt limit.
        this.#store.recordThumbnailFailure(taskId);
        continue;
      }
      try {
        const { contentType, bytes } = await this.#download(url);
        if (this.#closed) break;
        this.#store.putThumbnail(taskId, contentType, bytes);
        stored++;
      } catch (error) {
        if (this.#closed) break;
        this.#store.recordThumbnailFailure(taskId);
        this.#logger.warn(`thumbnail of history job ${taskId} not stored: ${(error as Error).message}`);
      }
    }
    return stored;
  }

  #fromPrinter(url: string): boolean {
    try {
      const parsed = new URL(url);
      return parsed.protocol === "http:" && parsed.hostname === this.#printerHost;
    } catch {
      return false;
    }
  }

  /** One thumbnail request: 200, an image type, and at most the byte limit, read in chunks. */
  async #download(url: string): Promise<{ contentType: string; bytes: Uint8Array }> {
    const signal = AbortSignal.any([AbortSignal.timeout(this.#thumbnailTimeoutMs), this.#abort.signal]);
    const response = await this.#fetch(url, { redirect: "error", signal });
    try {
      if (response.status !== 200) throw new Error(`answered HTTP ${response.status}`);
      const contentType = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      if (!THUMBNAIL_TYPES.has(contentType)) throw new Error(`answered content type "${contentType}"`);
      const length = Number(response.headers.get("content-length") ?? NaN);
      if (length > this.#thumbnailMaxBytes) throw new Error(`is ${length} bytes, over ${this.#thumbnailMaxBytes}`);
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (response.body !== null) {
        for await (const chunk of response.body) {
          size += chunk.byteLength;
          if (size > this.#thumbnailMaxBytes) throw new Error(`is over ${this.#thumbnailMaxBytes} bytes`);
          chunks.push(chunk);
        }
      }
      return { contentType, bytes: Buffer.concat(chunks) };
    } finally {
      // Drops the rest of a body that was not read to its end.
      if (response.body !== null && !response.bodyUsed) await response.body.cancel().catch(() => {});
    }
  }

  /** Sends one history command and checks its `Ack`. */
  async #request(cmd: number, data: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await this.#session.send(cmd, data);
    const answer = response.Data.Data;
    if (answer.Ack !== 0) throw new Error(`SDCP command ${cmd} answered Ack ${String(answer.Ack)}`);
    return answer;
  }
}

/** The `HistoryData` ids of a Cmd 320 answer. */
function historyIds(answer: Record<string, unknown>): string[] {
  const ids = answer.HistoryData;
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")) {
    throw new Error("SDCP command 320 answered without a HistoryData list of ids");
  }
  return ids.filter((id) => id !== "");
}

/** The valid entries of a Cmd 321 answer; entries without a `TaskId` are skipped. */
function detailJobs(answer: Record<string, unknown>): JobRecord[] {
  const list = answer.HistoryDetailList;
  if (!Array.isArray(list)) {
    throw new Error("SDCP command 321 answered without a HistoryDetailList");
  }
  return list.map(jobFromDetail).filter((job) => job !== null);
}
