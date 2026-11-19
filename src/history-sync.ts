// Fills the history archive from the printer's own job history (design D4):
// Cmd 320 for the ids, then Cmd 321 for the ids the archive lacks or holds as
// running. It sends nothing else for history, runs one sync at a time, and a
// failed sync only logs a warning: the session, status, and events never see it.
import { EventEmitter } from "node:events";
import { type HistoryStore, jobFromDetail, type JobRecord, TASK_STATUS_RUNNING } from "./history-store.ts";
import { Cmd, type Logger, type SdcpResponse } from "./sdcp-client.ts";

/** The ids one Cmd 321 asks for at most: the size the printer's web UI sends. */
export const DETAIL_CHUNK_SIZE = 26;

/** What the sync needs of the printer session. */
export interface HistorySession {
  send(cmd: number, data?: Record<string, unknown>): Promise<SdcpResponse>;
}

export interface HistorySyncOptions {
  session: HistorySession;
  store: HistoryStore;
  logger?: Logger;
}

type SyncEvents = {
  /** Once per sync that stored something. */
  change: [];
};

export class HistorySync extends EventEmitter<SyncEvents> {
  readonly #session: HistorySession;
  readonly #store: HistoryStore;
  readonly #logger: Logger;
  #running: Promise<void> | null = null;
  #again = false;
  #closed = false;

  constructor(options: HistorySyncOptions) {
    super();
    this.#session = options.session;
    this.#store = options.store;
    this.#logger = options.logger ?? console;
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
    } catch (error) {
      if (!this.#closed) this.#logger.warn(`history sync failed: ${(error as Error).message}`);
    }
    if (changed > 0 && !this.#closed) this.emit("change");
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
