// Notification Photos (design D3): one still JPEG from the printer's camera,
// taken when an Event is detected and attached to its Notification. A take
// is capped at 5 s from its request (the Event's detection), queue wait
// included, and never rejects: a failure is a result
// with the reason, and the Notification goes out text-only. The Photo light
// (design D4, docs/adr/0001-photo-light-automatic-command.md) turns the
// chamber light on for the Photo through the dashboard's own guard, and off
// again unless someone else changed it meanwhile.
import type { EventType } from "./config.ts";
import type { CommandResult } from "./print-control.ts";
import type { Logger } from "./sdcp-client.ts";
import type { StatusSnapshot } from "./status-store.ts";

/** The Events whose Notification carries a Photo when photos are on. */
export const PHOTO_EVENTS: ReadonlySet<EventType> = new Set<EventType>(["finished", "failed", "stopped", "paused"]);

export type PhotoResult = { jpeg: Buffer } | { jpeg: null; reason: string };

/** Where the frame comes from (a CameraProxy). */
export interface FrameSource {
  takeFrame(options: { signal: AbortSignal; after?: Promise<unknown> }): Promise<Buffer>;
}

/** The light as the status store reports it (a StatusStore). */
export interface LightState {
  readonly snapshot: StatusSnapshot;
  on(event: "change", listener: (snapshot: StatusSnapshot) => void): unknown;
  off(event: "change", listener: (snapshot: StatusSnapshot) => void): unknown;
}

/** The guarded light command and its counter (a PrintControl). */
export interface LightControl {
  readonly lightCommands: number;
  setLight(on: boolean): Promise<CommandResult>;
}

export interface PhotoTakerOptions {
  camera: FrameSource;
  /** The Photo light; null takes every Photo with the light as it is. */
  light: { state: LightState; control: LightControl } | null;
  /** A take ends within this many milliseconds of its request. 5 s by default. */
  limitMs?: number;
  /** The longest wait for a status push showing the light on. 3 s by default. */
  lightWaitMs?: number;
  logger?: Logger;
}

const TIMED_OUT = "photo timed out";
const CLOSED = "service is shutting down";
/** The time a shortened light wait leaves for the frame. */
const FRAME_RESERVE_MS = 2_000;

/** Takes Photos one at a time, each within its time limit. */
export class PhotoTaker {
  private readonly camera: FrameSource;
  private readonly light: PhotoTakerOptions["light"];
  private readonly limitMs: number;
  private readonly lightWaitMs: number;
  private readonly logger: Logger;
  /** The end of the last take requested; the next one starts after it. */
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  /**
   * `lightCommands` right after our last restore sent its off command, or
   * null: while it still matches, an "on" report predates that off.
   */
  private offSentAt: number | null = null;

  constructor(options: PhotoTakerOptions) {
    this.camera = options.camera;
    this.light = options.light;
    this.limitMs = options.limitMs ?? 5_000;
    this.lightWaitMs = options.lightWaitMs ?? 3_000;
    this.logger = options.logger ?? console;
  }

  /**
   * Takes one Photo after any take already running, so two Events in quick
   * succession never share the camera or the light. The limit runs from this
   * call, so a queued take gets only the time left. Never rejects.
   */
  take(): Promise<PhotoResult> {
    const deadline = Date.now() + this.limitMs;
    // A timer rather than AbortSignal.timeout(), so the limit follows the
    // same clock as every other timer (and node:test mock timers drive it).
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<PhotoResult>((resolve) => {
      timer = setTimeout(() => {
        abort.abort();
        resolve({ jpeg: null, reason: TIMED_OUT });
      }, this.limitMs);
    });
    const run = this.queue.then(() => this.run(deadline, abort.signal));
    this.queue = run;
    // The timer settles the take even while it waits in the queue.
    return Promise.race([run, timedOut]).finally(() => clearTimeout(timer));
  }

  /**
   * Stops taking Photos: a take still queued is not attempted. Resolves once
   * the running take has ended and its light restore was sent, or after
   * `waitMs` at most, so a shutdown can stop the session after the restore
   * without ever hanging on a take. The caller ends the running take by
   * closing the frame source.
   */
  close(waitMs = 1_000): Promise<void> {
    this.closed = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<void>((resolve) => (timer = setTimeout(resolve, waitMs)));
    const idle = this.queue.then(
      () => {},
      () => {},
    );
    return Promise.race([idle, bound]).finally(() => clearTimeout(timer));
  }

  private async run(deadline: number, signal: AbortSignal): Promise<PhotoResult> {
    if (this.closed) return { jpeg: null, reason: CLOSED };
    const remaining = deadline - Date.now();
    // Its time ran out while it waited: neither the camera nor the light.
    if (signal.aborted || remaining <= 0) return { jpeg: null, reason: TIMED_OUT };

    const aborted = new Promise<PhotoResult>((resolve) =>
      signal.addEventListener("abort", () => resolve({ jpeg: null, reason: TIMED_OUT }), { once: true }),
    );
    const light = this.lightUp(Math.min(this.lightWaitMs, remaining - FRAME_RESERVE_MS));
    const frame = this.camera.takeFrame({ signal, after: light?.ready }).then(
      (jpeg): PhotoResult => ({ jpeg }),
      (error: unknown): PhotoResult => ({ jpeg: null, reason: messageOf(error) }),
    );
    try {
      // The abort ends the run even when the source ignores the signal, so
      // the next take in the queue starts at once.
      return await Promise.race([frame, aborted]);
    } finally {
      light?.restore();
    }
  }

  /**
   * Turns the light on when the Photo light is on and the light is off, and
   * returns when the frame may be taken (`ready`) and how to put the light
   * back (`restore`). Undefined when no command was sent: the Photo is taken
   * with the light as it is. `waitMs` is the longest wait for the light; at
   * or below 0 the frame is armed at once.
   */
  private lightUp(waitMs: number): { ready: Promise<void>; restore: () => void } | undefined {
    if (this.light === null) return undefined;
    const { state, control } = this.light;
    let last = state.snapshot.light;
    // Right after our own off command the store can still report "on" until
    // the next push: unless anyone sent a light command since, the light is off.
    const staleOn = last === "on" && control.lightCommands === this.offSentAt;
    if (last !== "off" && !staleOn) return undefined;

    const before = control.lightCommands;
    const sent = control.setLight(true);
    // The guard decides before sending, so the counter tells at once whether
    // the command went out; a refusal (offline, LightStatus unknown) sent nothing.
    const ours = control.lightCommands;
    if (ours === before) {
      sent.catch(() => {});
      return undefined;
    }
    // The response can take 10 s: the status push decides, not the Ack.
    sent.then(
      (result) => this.logResult("on", result),
      (error: unknown) => this.logger.warn(`photo: turning the light on failed: ${messageOf(error)}`),
    );

    let seenOn = false;
    let offAfterOn = false;
    let lightWait: ReturnType<typeof setTimeout> | undefined;
    let markReady = () => {};
    const ready = new Promise<void>((resolve) => {
      markReady = resolve;
      if (waitMs <= 0) resolve();
      else lightWait = setTimeout(resolve, waitMs);
    });
    // Only a change to "on" counts, so a stale "on" (and the "off" push of
    // our earlier off command that follows it) neither arms nor blocks.
    const onChange = (snapshot: StatusSnapshot) => {
      if (snapshot.light === "on" && last !== "on") {
        seenOn = true;
        markReady();
      } else if (snapshot.light === "off" && seenOn) {
        offAfterOn = true;
      }
      last = snapshot.light;
    };
    state.on("change", onChange);

    const restore = () => {
      clearTimeout(lightWait);
      state.off("change", onChange);
      // Leave the light alone when anyone else sent a light command or it was
      // switched off elsewhere after it came on. No "on" report is required:
      // the push showing our command often lands after the wait or the Photo.
      if (control.lightCommands !== ours || offAfterOn) return;
      const off = control.setLight(false);
      // Sent when the guard let it through (the counter moved).
      if (control.lightCommands !== ours) this.offSentAt = control.lightCommands;
      off.then(
        (result) => this.logResult("off", result),
        (error: unknown) => this.logger.warn(`photo: turning the light off again failed: ${messageOf(error)}`),
      );
    };
    return { ready, restore };
  }

  private logResult(direction: "on" | "off", result: CommandResult): void {
    if (result.outcome === "failed") {
      this.logger.warn(`photo: turning the light ${direction} failed with code ${result.code ?? "unknown"}`);
    } else if (result.outcome === "timeout") {
      this.logger.warn(`photo: turning the light ${direction} got no response`);
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
