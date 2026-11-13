// Push delivery of print events (print-notifications spec). Channels sit
// behind the Notifier interface; ntfy is the default channel. A delivery
// failure is retried, then logged, and never reaches the printer session:
// notify() always resolves.
import type { Config, EventType } from "./config.ts";
import type { PrintEvent } from "./event-detector.ts";
import type { Logger } from "./sdcp-client.ts";

/** A push channel. notify() resolves once delivered or given up; it never rejects. */
export interface Notifier {
  notify(event: PrintEvent): Promise<void>;
}

/** One push message, channel-neutral. */
export interface PushMessage {
  title: string;
  message: string;
  /** ntfy priority: 3 default, 4 high. */
  priority: 3 | 4;
  /** ntfy tags (emoji short codes). */
  tags: string[];
}

/** Waits before retries 1, 2, and 3. */
export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [1000, 2000, 4000];

/** Per-request timeout, so a server that never answers counts as a failed attempt. */
const REQUEST_TIMEOUT_MS = 10_000;

/** Builds the push message for an event. */
export function formatEvent(event: PrintEvent): PushMessage {
  const file = event.fileName ?? "The print";
  const at = event.progress === null ? "" : ` at ${event.progress}%`;
  const printer = event.printerName ?? "The printer";
  switch (event.type) {
    case "started":
      return { title: "Print started", message: `${file} started.`, priority: 3, tags: ["printer"] };
    case "finished": {
      const took = event.durationSeconds === null ? "" : ` in ${formatDuration(event.durationSeconds)}`;
      return { title: "Print finished", message: `${file} finished${took}.`, priority: 3, tags: ["white_check_mark"] };
    }
    case "failed": {
      const code = event.errorCode === null ? "" : ` (error code ${event.errorCode})`;
      return { title: "Print failed", message: `${file} failed${at}${code}.`, priority: 4, tags: ["x"] };
    }
    case "paused":
      return { title: "Print paused", message: `${file} paused${at}.`, priority: 3, tags: ["pause_button"] };
    case "stopped":
      return { title: "Print stopped", message: `${file} stopped${at}.`, priority: 3, tags: ["stop_sign"] };
    case "offline":
      return { title: "Printer offline", message: `${printer} has been unreachable for 2 minutes.`, priority: 4, tags: ["warning"] };
    case "online":
      return { title: "Printer back online", message: `${printer} is reachable again.`, priority: 3, tags: ["electric_plug"] };
  }
}

/** "1h 02m", "6m 38s", "45s". */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${s}s`;
}

export interface NtfyNotifierOptions {
  /** ntfy server, e.g. https://ntfy.sh or a self-hosted one. */
  url: string;
  topic: string;
  /** Which event types are sent. */
  events: Record<EventType, boolean>;
  /** Waits before each retry; its length is the retry count. DEFAULT_RETRY_DELAYS_MS by default. */
  retryDelaysMs?: readonly number[];
  logger?: Logger;
}

/** Publishes events to an ntfy topic (JSON publish to the server root). */
export class NtfyNotifier implements Notifier {
  private readonly url: string;
  private readonly topic: string;
  private readonly events: Record<EventType, boolean>;
  private readonly retryDelaysMs: readonly number[];
  private readonly logger: Logger;

  constructor(options: NtfyNotifierOptions) {
    this.url = options.url.replace(/\/+$/, "");
    this.topic = options.topic;
    this.events = { ...options.events };
    this.retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.logger = options.logger ?? console;
  }

  async notify(event: PrintEvent): Promise<void> {
    if (!this.events[event.type]) return;
    await this.publish(formatEvent(event), event.type);
  }

  /**
   * Publishes one message, retrying with back-off. Resolves true once
   * delivered, false after the last retry failed (the failure is logged).
   */
  async publish(push: PushMessage, label = push.title): Promise<boolean> {
    const body = JSON.stringify({ topic: this.topic, title: push.title, message: push.message, priority: push.priority, tags: push.tags });
    let failure = "";
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await fetch(`${this.url}/`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        await response.body?.cancel();
        if (response.ok) return true;
        failure = `HTTP ${response.status}`;
      } catch (error) {
        const cause = (error as Error & { cause?: Error }).cause;
        failure = cause?.message ?? (error as Error).message;
      }
      const delay = this.retryDelaysMs[attempt];
      if (delay === undefined) break;
      this.logger.warn(`ntfy: ${label} not delivered (${failure}); retry ${attempt + 1} of ${this.retryDelaysMs.length} in ${delay} ms`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    this.logger.error(`ntfy: gave up on ${label} after ${this.retryDelaysMs.length} retries: ${failure}`);
    return false;
  }
}

/** The configured channel: ntfy when a topic is set, else none (notifications off). */
export function notifierFromConfig(config: Pick<Config, "ntfy" | "events">, logger?: Logger): NtfyNotifier | null {
  if (config.ntfy.topic === null) return null;
  return new NtfyNotifier({ url: config.ntfy.url, topic: config.ntfy.topic, events: config.events, logger });
}
