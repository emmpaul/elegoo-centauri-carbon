// Detects print lifecycle events from status snapshot changes (design D4):
// started, finished, failed, paused, stopped, offline (after 2 minutes
// unreachable), and back online. Every event occurrence is emitted at most
// once, keyed on the job plus the event type, so repeated status pushes and
// reconnects never repeat an event.
//
// The printer clears `TaskId`, `Filename`, and `Progress` in the push that
// reports a completed job (docs/sdcp-protocol.md, "Is `TaskId` a stable job
// id?"), so the detector keeps the job it saw while it ran, and reports the
// file name, progress, and job id from there.
import { EventEmitter } from "node:events";
import type { EventType } from "./config.ts";
import type { Logger } from "./sdcp-client.ts";
import type { StatusSnapshot } from "./status-store.ts";

export interface PrintEvent {
  type: EventType;
  /** When the event was detected (ms since epoch). */
  at: number;
  printerName: string | null;
  /** The job's `TaskId` (or file name + start time without one); null for offline and online. */
  jobId: string | null;
  fileName: string | null;
  /** Percent; the last value seen while the job ran (100 for a finished job). */
  progress: number | null;
  /** Print time in seconds as the printer counts it (`CurrentTicks`). */
  durationSeconds: number | null;
  /** Raw `ErrorStatusReason` of the job (failed events); null when unknown. */
  errorCode: number | null;
}

export interface EventDetectorOptions {
  /** Unreachable time before "offline" is emitted. 2 minutes by default. */
  offlineAfterMs?: number;
  /**
   * Asks the printer for the error code of a job that just ended (a Cmd 321
   * task detail): resolves with the raw `ErrorStatusReason`, or null when the
   * answer has none. A non-zero code turns the job's end into "failed". When
   * missing or when it rejects, the snapshot's own `errorCode` is used.
   */
  taskErrorCode?: (taskId: string) => Promise<number | null>;
  now?: () => number;
  logger?: Logger;
}

/** Anything that holds the current snapshot and emits "change" with each new one (a StatusStore). */
export interface SnapshotSource {
  readonly snapshot: StatusSnapshot;
  on(event: "change", listener: (snapshot: StatusSnapshot) => void): unknown;
  off(event: "change", listener: (snapshot: StatusSnapshot) => void): unknown;
}

interface Job {
  key: string;
  taskId: string | null;
  fileName: string | null;
  progress: number | null;
  elapsed: number | null;
  paused: boolean;
  /** Pause occurrences so far; each resume arms the next one. */
  pauses: number;
  ended: boolean;
}

/** Machine states during which a job runs (`printing`, and the mid-job material change). */
const ACTIVE_MACHINE_STATES = new Set(["printing", "loading-material"]);

type DetectorEvents = { event: [PrintEvent] };

export class EventDetector extends EventEmitter<DetectorEvents> {
  private readonly offlineAfterMs: number;
  private readonly taskErrorCode: EventDetectorOptions["taskErrorCode"];
  private readonly now: () => number;
  private readonly logger: Logger;
  private readonly emitted = new Set<string>();
  private source: SnapshotSource | undefined;
  private readonly listener = (snapshot: StatusSnapshot) => this.handle(snapshot);
  /** False until the first snapshot with a known machine state: that one is the baseline and emits nothing. */
  private initialized = false;
  private job: Job | null = null;
  private offlineTimer: NodeJS.Timeout | undefined;
  private offlineSent = false;
  private outages = 0;

  constructor(options: EventDetectorOptions = {}) {
    super();
    this.offlineAfterMs = options.offlineAfterMs ?? 120_000;
    this.taskErrorCode = options.taskErrorCode;
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? console;
  }

  /** Follows a store's snapshots, starting with its current one. */
  attach(source: SnapshotSource): void {
    this.source = source;
    source.on("change", this.listener);
    this.handle(source.snapshot);
  }

  /** Stops following the store and cancels the pending offline timer. */
  close(): void {
    this.source?.off("change", this.listener);
    this.source = undefined;
    clearTimeout(this.offlineTimer);
    this.offlineTimer = undefined;
  }

  /** Processes one snapshot. */
  handle(snapshot: StatusSnapshot): void {
    this.trackConnection(snapshot);
    if (snapshot.machineState.code === null) return;
    const baseline = !this.initialized;
    this.initialized = true;
    if (ACTIVE_MACHINE_STATES.has(snapshot.machineState.name)) this.trackActive(snapshot, baseline);
    else this.trackInactive(snapshot);
  }

  private trackConnection(snapshot: StatusSnapshot): void {
    if (snapshot.connection === "online") {
      clearTimeout(this.offlineTimer);
      this.offlineTimer = undefined;
      if (!this.offlineSent) return;
      this.offlineSent = false;
      this.emitOnce(`online:${this.outages++}`, this.event("online", snapshot.printerName, null));
      return;
    }
    if (this.offlineTimer !== undefined || this.offlineSent) return;
    const printerName = snapshot.printerName;
    this.offlineTimer = setTimeout(() => {
      this.offlineTimer = undefined;
      this.offlineSent = true;
      this.emitOnce(`offline:${this.outages}`, this.event("offline", printerName, null));
    }, this.offlineAfterMs);
  }

  private trackActive(snapshot: StatusSnapshot, baseline: boolean): void {
    let job = this.job;
    if (job === null || job.ended || !sameJob(job, snapshot)) {
      // The job's identity shows up a push or two after it starts.
      if (snapshot.taskId === null && snapshot.fileName === null) return;
      job = {
        key: snapshot.taskId ?? `${snapshot.fileName}@${this.now()}`,
        taskId: snapshot.taskId,
        fileName: snapshot.fileName,
        progress: snapshot.progress,
        elapsed: snapshot.elapsed,
        paused: false,
        pauses: 0,
        ended: false,
      };
      this.job = job;
      // Joining a job that was already running is not a start.
      if (!baseline) this.emitOnce(`${job.key}:started`, this.jobEvent("started", snapshot, job));
    }
    job.taskId = snapshot.taskId ?? job.taskId;
    job.fileName = snapshot.fileName ?? job.fileName;
    job.progress = snapshot.progress ?? job.progress;
    job.elapsed = snapshot.elapsed ?? job.elapsed;

    if (snapshot.printState.name === "paused") {
      if (!job.paused && !baseline) this.emitOnce(`${job.key}:paused:${job.pauses}`, this.jobEvent("paused", snapshot, job));
      job.paused = true;
    } else if (snapshot.printState.name === "printing" && job.paused) {
      job.paused = false;
      job.pauses++;
    }

    if (snapshot.errorCode !== null && snapshot.errorCode !== 0) {
      this.emitOnce(`${job.key}:failed`, this.jobEvent("failed", snapshot, job, snapshot.errorCode));
    }
  }

  private trackInactive(snapshot: StatusSnapshot): void {
    const job = this.job;
    if (job === null || job.ended) return;
    const name = snapshot.printState.name;
    const outcome = name === "completed" ? "finished" : name === "stopped" ? "stopped" : null;
    if (outcome === null) return; // e.g. "stopping": wait for the final state
    job.ended = true;
    job.elapsed = snapshot.elapsed ?? job.elapsed;
    void this.endJob(job, outcome, snapshot);
  }

  /** Emits the end of a job: "failed" when its error code is non-zero, else the outcome. */
  private async endJob(job: Job, outcome: "finished" | "stopped", snapshot: StatusSnapshot): Promise<void> {
    let errorCode = snapshot.errorCode;
    if (job.taskId !== null && this.taskErrorCode !== undefined) {
      try {
        errorCode = await this.taskErrorCode(job.taskId);
      } catch (error) {
        this.logger.warn(`could not read the error code of job ${job.taskId}: ${(error as Error).message}`);
      }
    }
    if (errorCode !== null && errorCode !== 0) {
      this.emitOnce(`${job.key}:failed`, this.jobEvent("failed", snapshot, job, errorCode));
    } else if (!this.emitted.has(`${job.key}:failed`)) {
      const event = this.jobEvent(outcome, snapshot, job);
      // The printer resets Progress to 0 on completion.
      if (outcome === "finished") event.progress = 100;
      this.emitOnce(`${job.key}:${outcome}`, event);
    }
  }

  private jobEvent(type: EventType, snapshot: StatusSnapshot, job: Job, errorCode: number | null = null): PrintEvent {
    return {
      ...this.event(type, snapshot.printerName, job.key),
      fileName: job.fileName,
      progress: job.progress,
      durationSeconds: job.elapsed,
      errorCode,
    };
  }

  private event(type: EventType, printerName: string | null, jobId: string | null): PrintEvent {
    return { type, at: this.now(), printerName, jobId, fileName: null, progress: null, durationSeconds: null, errorCode: null };
  }

  private emitOnce(key: string, event: PrintEvent): void {
    if (this.emitted.has(key)) return;
    this.emitted.add(key);
    this.emit("event", event);
  }
}

/** Whether an active snapshot belongs to `job`: ids (or file names) match where both are known. */
function sameJob(job: Job, snapshot: StatusSnapshot): boolean {
  if (job.taskId !== null && snapshot.taskId !== null) return job.taskId === snapshot.taskId;
  if (job.fileName !== null && snapshot.fileName !== null) return job.fileName === snapshot.fileName;
  return true;
}
