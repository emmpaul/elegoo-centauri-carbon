// Control commands of the dashboard (design D8): sends one command at a time
// to /api/command and follows it through pending to its outcome, which the
// page shows in the message slot and on the control. It touches no DOM, so
// `node --test` drives it with a stub fetch and mock timers.
import type { ControlAction } from "../src/control-rules.ts";
import type { CommandResult } from "../src/print-control.ts";
import type { StatusSnapshot } from "../src/status-store.ts";
import { ACK_CLEAR_MS, type CommandState, canRetry } from "./view.js";

/** The page aborts a command request after this long and shows it as timed out (the service's own limit is 10 s). */
export const COMMAND_ABORT_MS = 15_000;

/** What the commands need from the page. */
export interface CommandHost {
  /** Fetch with the access token. */
  fetch(path: string, init: RequestInit): Promise<Response>;
  /** The latest status snapshot, for the control rules. */
  snapshot(): StatusSnapshot | null;
  /** Whether the event stream to the service is open. */
  streamOpen(): boolean;
  /** The command state changed: render again. */
  changed(): void;
  /** The service answered 401: check the token again. */
  unauthorized(): void;
}

/** The service's error message as a sentence for the sub-line. */
export function reasonOf(payload: unknown, status: number): string {
  const message = (payload as { error?: { message?: unknown } } | null)?.error?.message;
  const text = typeof message === "string" && message !== "" ? message : `the service answered HTTP ${status}`;
  return `${text[0]!.toUpperCase()}${text.slice(1)}.`;
}

export class Commands {
  /** The command in flight or last answered; one at a time. */
  state: CommandState | null = null;
  /** The request body of `state`, re-sent by Retry. */
  #body: Record<string, unknown> | null = null;
  #ackTimer: ReturnType<typeof setTimeout> | undefined;
  #host: CommandHost;

  constructor(host: CommandHost) {
    this.#host = host;
  }

  #set(next: CommandState | null): void {
    clearTimeout(this.#ackTimer);
    this.state = next;
    if (next !== null && next.status === "ack") {
      this.#ackTimer = setTimeout(() => {
        if (this.state === next) this.#set(null);
      }, ACK_CLEAR_MS);
    }
    this.#host.changed();
  }

  /** Sends one command and follows it through pending to its outcome; ignored while another is in flight. */
  async send(action: ControlAction, body: Record<string, unknown>): Promise<void> {
    if (this.state?.status === "pending") return;
    this.#body = body;
    this.#set({ action, status: "pending" });
    const abort = new AbortController();
    const safety = setTimeout(() => abort.abort(), COMMAND_ABORT_MS);
    try {
      const response = await this.#host.fetch("/api/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: abort.signal,
      });
      const payload = (await response.json().catch(() => null)) as unknown;
      if (response.ok && payload !== null && typeof payload === "object" && "outcome" in payload) {
        const result = payload as CommandResult;
        if (result.outcome === "acknowledged") this.#set({ action, status: "ack" });
        else if (result.outcome === "failed") this.#set({ action, status: "failed", code: result.code });
        else this.#set({ action, status: "timeout" });
      } else {
        this.#set({ action, status: "failed", code: null, reason: reasonOf(payload, response.status) });
        if (response.status === 401) this.#host.unauthorized();
      }
    } catch {
      if (abort.signal.aborted) this.#set({ action, status: "timeout" });
      else this.#set({ action, status: "failed", code: null, reason: "The service can’t be reached." });
    } finally {
      clearTimeout(safety);
    }
  }

  /** Stop, sent only from the slide, always with the confirmation flag. */
  stop(): Promise<void> {
    return this.send("stop", { action: "stop", confirm: true });
  }

  /** Re-sends the last command's own request, when Retry is shown (`canRetry`). */
  retry(): Promise<void> {
    if (this.state === null || this.#body === null) return Promise.resolve();
    if (!canRetry(this.state, this.#host.snapshot(), this.#host.streamOpen())) return Promise.resolve();
    const { action } = this.state;
    const body = this.#body;
    this.#set(null);
    return this.send(action, body);
  }

  /** Clears the message slot. */
  dismiss(): void {
    this.#set(null);
  }
}
