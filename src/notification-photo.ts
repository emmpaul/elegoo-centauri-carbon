// Notification Photos (design D3): one still JPEG from the printer's camera,
// taken when an Event is detected and attached to its Notification. A take
// is capped at 5 s from its start and never rejects: a failure is a result
// with the reason, and the Notification goes out text-only.
import type { EventType } from "./config.ts";

/** The Events whose Notification carries a Photo when photos are on. */
export const PHOTO_EVENTS: ReadonlySet<EventType> = new Set<EventType>(["finished", "failed", "stopped", "paused"]);

export type PhotoResult = { jpeg: Buffer } | { jpeg: null; reason: string };

/** Where the frame comes from (a CameraProxy). */
export interface FrameSource {
  takeFrame(options: { signal: AbortSignal; after?: Promise<unknown> }): Promise<Buffer>;
}

export interface PhotoTakerOptions {
  camera: FrameSource;
  /** The Photo light; null takes every Photo with the light as it is. */
  light: null;
  /** A take ends within this many milliseconds of its start. 5 s by default. */
  limitMs?: number;
}

const TIMED_OUT = "photo timed out";

/** Takes Photos one at a time, each within its time limit. */
export class PhotoTaker {
  private readonly camera: FrameSource;
  private readonly limitMs: number;
  /** The end of the last take requested; the next one starts after it. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: PhotoTakerOptions) {
    this.camera = options.camera;
    this.limitMs = options.limitMs ?? 5_000;
  }

  /**
   * Takes one Photo after any take already running, so two Events in quick
   * succession never share the camera or the light. Never rejects.
   */
  take(): Promise<PhotoResult> {
    const result = this.queue.then(() => this.run());
    this.queue = result;
    return result;
  }

  private async run(): Promise<PhotoResult> {
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
    const frame = this.camera.takeFrame({ signal: abort.signal }).then(
      (jpeg): PhotoResult => ({ jpeg }),
      (error: unknown): PhotoResult => ({ jpeg: null, reason: error instanceof Error ? error.message : String(error) }),
    );
    try {
      // The timer settles the take even when the source ignores the signal.
      return await Promise.race([frame, timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }
}
