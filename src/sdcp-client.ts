// SDCP WebSocket client for the Centauri Carbon. Message shapes, command ids,
// and protocol versions come from docs/sdcp-protocol.md.
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

/**
 * Command ids this client may send: the subset of the "Command ids" table in
 * docs/sdcp-protocol.md that the service uses. Every other id, whether it is
 * undocumented or documented but out of scope (start print, file and history
 * edits, jogging), is refused.
 */
export const Cmd = {
  GET_PRINTER_STATUS: 0,
  GET_PRINTER_ATTR: 1,
  SEND_PRINTER_SUSPEND_PRINT: 129,
  SEND_PRINTER_STOP_PRINT: 130,
  SEND_PRINTER_RESTORE_PRINT: 131,
  GET_PRINTER_HISTORY_ID: 320,
  GET_PRINTER_TASK_DETAIL: 321,
  EDIT_PRINTER_VIDEO_STREAMING: 386,
  EDIT_PRINTER_STATUS_DATA: 403,
} as const;

export const ALLOWED_COMMANDS: ReadonlySet<number> = new Set(Object.values(Cmd));

/** Protocol versions listed in docs/sdcp-protocol.md ("Source artifacts"). */
export const DOCUMENTED_PROTOCOL_VERSIONS: readonly string[] = ["V3.0.0"];

/** `ws://<host>:3030/websocket`, the printer's SDCP endpoint. */
export function sdcpUrl(host: string): string {
  return `ws://${host}:3030/websocket`;
}

export interface SdcpRequest {
  Id: "";
  Data: {
    Cmd: number;
    Data: Record<string, unknown>;
    RequestID: string;
    MainboardID: string;
    TimeStamp: number;
    From: 1;
  };
}

/** Builds the request envelope exactly as the web UI does (docs: "Request envelope"). */
export function buildRequest(
  cmd: number,
  data: Record<string, unknown> = {},
  mainboardId = "",
  requestId: string = newRequestId(),
  now: number = Date.now(),
): SdcpRequest {
  return { Id: "", Data: { Cmd: cmd, Data: data, RequestID: requestId, MainboardID: mainboardId, TimeStamp: now, From: 1 } };
}

/** A uuid v4 without dashes (32 hex characters). */
export function newRequestId(): string {
  return randomUUID().replaceAll("-", "");
}

export interface SdcpResponse {
  Id: string;
  Data: { Cmd: number; Data: { Ack?: number } & Record<string, unknown>; RequestID: string; MainboardID: string; TimeStamp: number };
  Topic: string;
}

export interface StatusMessage {
  Status: Record<string, unknown>;
  MainboardID: string;
  TimeStamp: number;
  Topic: string;
}

export interface AttributesMessage {
  Attributes: Record<string, unknown>;
  MainboardID: string;
  TimeStamp: number;
  Topic: string;
}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export class UndocumentedCommandError extends Error {
  readonly cmd: number;
  constructor(cmd: number) {
    super(`refusing to send SDCP command ${cmd}: not in the protocol reference allow-list`);
    this.name = "UndocumentedCommandError";
    this.cmd = cmd;
  }
}

export class CommandTimeoutError extends Error {
  readonly cmd: number;
  constructor(cmd: number, timeoutMs: number) {
    super(`SDCP command ${cmd} got no response within ${timeoutMs} ms`);
    this.name = "CommandTimeoutError";
    this.cmd = cmd;
  }
}

export class NotConnectedError extends Error {
  constructor(message = "SDCP session is not open") {
    super(message);
    this.name = "NotConnectedError";
  }
}

/**
 * Logs a warning when `version` is not a documented protocol version. Returns
 * whether it is documented; callers keep connecting either way.
 */
export function checkProtocolVersion(version: string, logger: Logger): boolean {
  if (DOCUMENTED_PROTOCOL_VERSIONS.includes(version)) return true;
  logger.warn(
    `printer reports SDCP protocol version "${version}", which the protocol reference does not list ` +
      `(known: ${DOCUMENTED_PROTOCOL_VERSIONS.join(", ")}); continuing`,
  );
  return false;
}

export interface SdcpClientOptions {
  url: string;
  logger?: Logger;
  /** How long `send` waits for the response; 10 s by default. */
  responseTimeoutMs?: number;
}

type ClientEvents = {
  open: [];
  close: [];
  status: [StatusMessage];
  attributes: [AttributesMessage];
};

interface Pending {
  cmd: number;
  resolve: (response: SdcpResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** One SDCP WebSocket session. */
export class SdcpClient extends EventEmitter<ClientEvents> {
  readonly url: string;
  private readonly logger: Logger;
  private readonly responseTimeoutMs: number;
  private socket: WebSocket | undefined;
  private readonly pending = new Map<string, Pending>();
  private readonly warnedVersions = new Set<string>();

  constructor(options: SdcpClientOptions) {
    super();
    this.url = options.url;
    this.logger = options.logger ?? console;
    this.responseTimeoutMs = options.responseTimeoutMs ?? 10_000;
  }

  get isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  /** Opens the session; resolves once open, rejects if it fails to open. */
  connect(): Promise<void> {
    if (this.socket !== undefined) return Promise.reject(new Error("SDCP session already started"));
    const socket = new WebSocket(this.url);
    this.socket = socket;
    return new Promise((resolve, reject) => {
      let opened = false;
      socket.addEventListener("open", () => {
        opened = true;
        this.emit("open");
        resolve();
      });
      socket.addEventListener("message", (event) => this.onMessage(event.data));
      socket.addEventListener("close", () => {
        if (this.socket === socket) this.socket = undefined;
        this.failPending(new NotConnectedError("SDCP session closed before the response arrived"));
        if (opened) this.emit("close");
        else reject(new NotConnectedError(`could not open ${this.url}`));
      });
      // A failed open is followed by "close", which rejects; nothing else to do here.
      socket.addEventListener("error", () => {});
    });
  }

  /** Closes the session. Pending requests reject. */
  close(): void {
    this.socket?.close();
  }

  /**
   * Sends a command and resolves with its response, matched by RequestID.
   * Refuses (and logs) command ids outside the allow-list without sending
   * anything. Rejects with CommandTimeoutError when no response arrives in time.
   */
  send(cmd: number, data: Record<string, unknown> = {}): Promise<SdcpResponse> {
    if (!ALLOWED_COMMANDS.has(cmd)) {
      const error = new UndocumentedCommandError(cmd);
      this.logger.error(error.message);
      return Promise.reject(error);
    }
    const socket = this.socket;
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) return Promise.reject(new NotConnectedError());
    const request = buildRequest(cmd, data);
    const requestId = request.Data.RequestID;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new CommandTimeoutError(cmd, this.responseTimeoutMs));
      }, this.responseTimeoutMs);
      this.pending.set(requestId, { cmd, resolve, reject, timer });
      socket.send(JSON.stringify(request));
    });
  }

  private onMessage(data: unknown): void {
    if (typeof data !== "string") return;
    let message: unknown;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    if (typeof message !== "object" || message === null) return;
    const topic = (message as { Topic?: unknown }).Topic;
    if (typeof topic !== "string") return;
    if (topic.startsWith("sdcp/response/")) this.onResponse(message as SdcpResponse);
    else if (topic.startsWith("sdcp/status/") && isObject((message as StatusMessage).Status)) {
      this.emit("status", message as StatusMessage);
    } else if (topic.startsWith("sdcp/attributes/") && isObject((message as AttributesMessage).Attributes)) {
      const attributes = message as AttributesMessage;
      const version = attributes.Attributes.ProtocolVersion;
      if (typeof version === "string" && !this.warnedVersions.has(version)) {
        if (!checkProtocolVersion(version, this.logger)) this.warnedVersions.add(version);
      }
      this.emit("attributes", attributes);
    } else if (topic.startsWith("sdcp/error/")) {
      this.logger.warn(`printer sent an SDCP error message: ${data}`);
    }
  }

  private onResponse(response: SdcpResponse): void {
    const requestId = isObject(response.Data) ? response.Data.RequestID : undefined;
    if (typeof requestId !== "string") return;
    const pending = this.pending.get(requestId);
    if (pending === undefined) return;
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve(response);
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
