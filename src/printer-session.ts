// Keeps one SDCP session to the printer open: reconnects with capped back-off
// after a drop, and asks for status when the printer has been silent.
import { EventEmitter } from "node:events";
import {
  type AttributesMessage,
  Cmd,
  type Logger,
  NotConnectedError,
  SdcpClient,
  type SdcpResponse,
  type StatusMessage,
} from "./sdcp-client.ts";

export type ConnectionState = "connecting" | "online" | "offline";

export interface PrinterSessionOptions {
  url: string;
  logger?: Logger;
  /** First reconnect delay; doubles per failed attempt. 1 s by default. */
  initialBackoffMs?: number;
  /** Cap on the reconnect delay. 60 s by default. */
  maxBackoffMs?: number;
  /** Silence after which status is requested. 30 s by default. */
  idlePollMs?: number;
  /** Response timeout passed to the client. */
  responseTimeoutMs?: number;
}

/** Delay before reconnect attempt `attempt` (0-based): initial * 2^attempt, capped. */
export function backoffDelay(attempt: number, initialMs = 1000, maxMs = 60_000): number {
  return Math.min(maxMs, initialMs * 2 ** Math.min(attempt, 30));
}

type SessionEvents = {
  state: [ConnectionState];
  status: [StatusMessage];
  attributes: [AttributesMessage];
};

export class PrinterSession extends EventEmitter<SessionEvents> {
  private readonly options: Required<Omit<PrinterSessionOptions, "logger" | "responseTimeoutMs">> &
    Pick<PrinterSessionOptions, "responseTimeoutMs">;
  private readonly logger: Logger;
  private client: SdcpClient | undefined;
  private stateValue: ConnectionState = "connecting";
  private attempt = 0;
  private stopped = true;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private idleTimer: NodeJS.Timeout | undefined;

  constructor(options: PrinterSessionOptions) {
    super();
    this.logger = options.logger ?? console;
    this.options = {
      url: options.url,
      initialBackoffMs: options.initialBackoffMs ?? 1000,
      maxBackoffMs: options.maxBackoffMs ?? 60_000,
      idlePollMs: options.idlePollMs ?? 30_000,
      responseTimeoutMs: options.responseTimeoutMs,
    };
  }

  get state(): ConnectionState {
    return this.stateValue;
  }

  /** Starts connecting; retries until stopped. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.connectOnce();
  }

  /** Stops retrying and closes the session. */
  stop(): void {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.idleTimer);
    this.reconnectTimer = undefined;
    this.idleTimer = undefined;
    const client = this.client;
    this.client = undefined;
    client?.close();
  }

  /** Sends a command over the open session (see SdcpClient.send). */
  send(cmd: number, data: Record<string, unknown> = {}): Promise<SdcpResponse> {
    if (this.client === undefined) return Promise.reject(new NotConnectedError());
    return this.client.send(cmd, data);
  }

  private async connectOnce(): Promise<void> {
    const client = new SdcpClient({ url: this.options.url, logger: this.logger, responseTimeoutMs: this.options.responseTimeoutMs });
    this.client = client;
    client.on("status", (message) => {
      if (this.client !== client) return;
      this.attempt = 0;
      this.setState("online");
      this.armIdlePoll();
      this.emit("status", message);
    });
    client.on("attributes", (message) => {
      if (this.client === client) this.emit("attributes", message);
    });
    client.on("close", () => {
      if (this.client !== client) return;
      this.logger.warn(`SDCP session to ${this.options.url} closed`);
      this.onLost();
    });
    try {
      await client.connect();
    } catch (error) {
      if (this.client !== client) return;
      this.logger.warn(`${(error as Error).message}`);
      this.onLost();
      return;
    }
    if (this.client !== client) {
      client.close();
      return;
    }
    this.armIdlePoll();
    this.request(Cmd.GET_PRINTER_STATUS);
    this.request(Cmd.GET_PRINTER_ATTR);
  }

  private onLost(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    this.client = undefined;
    this.setState("offline");
    if (this.stopped) return;
    const delay = backoffDelay(this.attempt, this.options.initialBackoffMs, this.options.maxBackoffMs);
    this.attempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.stopped) void this.connectOnce();
    }, delay);
  }

  /** (Re)starts the silence timer; when it fires, requests status and re-arms. */
  private armIdlePoll(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.client === undefined || this.stopped) return;
      this.request(Cmd.GET_PRINTER_STATUS);
      this.armIdlePoll();
    }, this.options.idlePollMs);
  }

  private request(cmd: number): void {
    this.client?.send(cmd).catch((error: Error) => this.logger.warn(`SDCP command ${cmd} failed: ${error.message}`));
  }

  private setState(state: ConnectionState): void {
    if (this.stateValue === state) return;
    this.stateValue = state;
    this.emit("state", state);
  }
}
