// Test-only fake SDCP printer: a WebSocket server on ws://127.0.0.1:<port>/websocket
// (host and port can be fixed, for scripts that stand in for the real printer)
// that answers requests like the real printer, replays recorded fixtures, and
// records every frame it receives. It never talks to a real printer.
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";

/** Mainboard id used by the fixtures. */
export const FIXTURE_MAINBOARD_ID = "40551f980103d46c00004c0000000000";
/** Fixed response `Id` the printer uses in every response. */
const RESPONSE_ID = "979d4C788A4a78bC777A870F1A02867A";

export interface FixtureFrame {
  seq: number;
  direction: "sent" | "received";
  tMs?: number;
  payload: unknown;
}

export interface Fixture {
  source: Record<string, unknown>;
  frames: FixtureFrame[];
}

/** Loads `test/fixtures/<name>`. */
export function loadFixture(name: string): Fixture {
  return JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8")) as Fixture;
}

/** One frame the fake received from a client. JSON frames are parsed; others stay text. */
export interface ReceivedFrame {
  text: string;
  payload: unknown;
}

/**
 * How the fake answers a request with command id `cmd`: an `Ack` value to
 * respond with, `"silent"` to send no response, or a function that builds the
 * response's `Data.Data` from the request's `Data.Data`.
 */
export type Reply = number | "silent" | ((data: Record<string, unknown>) => Record<string, unknown>);

export interface FakePrinterOptions {
  /** Per-command reply; commands not listed are answered with `Ack: 0`. */
  replies?: Record<number, Reply>;
  /** Address to listen on. 127.0.0.1 by default. */
  host?: string;
  /** Port to listen on. A free port by default. */
  port?: number;
}

export class FakePrinter {
  readonly received: ReceivedFrame[] = [];
  readonly replies: Map<number, Reply>;
  private readonly server: WebSocketServer;
  private readonly frameListeners = new Set<(frame: ReceivedFrame) => void>();
  private silent = false;
  private readonly host: string;

  private constructor(server: WebSocketServer, options: FakePrinterOptions) {
    this.server = server;
    this.host = urlHost(options.host ?? "127.0.0.1");
    this.replies = new Map(Object.entries(options.replies ?? {}).map(([cmd, reply]) => [Number(cmd), reply]));
    server.on("connection", (socket) => {
      socket.on("message", (data, isBinary) => {
        const text = isBinary ? Buffer.from(data as Buffer).toString("utf8") : data.toString();
        const frame: ReceivedFrame = { text, payload: parse(text) };
        this.received.push(frame);
        this.answer(socket, frame.payload);
        for (const listener of this.frameListeners) listener(frame);
      });
    });
  }

  /** Starts a fake printer, by default on a free port on 127.0.0.1. */
  static async start(options: FakePrinterOptions = {}): Promise<FakePrinter> {
    const server = new WebSocketServer({ host: options.host ?? "127.0.0.1", port: options.port ?? 0, path: "/websocket" });
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    return new FakePrinter(server, options);
  }

  get port(): number {
    return (this.server.address() as AddressInfo).port;
  }

  get url(): string {
    return `ws://${this.host}:${this.port}/websocket`;
  }

  /** Number of open client connections. */
  get clientCount(): number {
    return this.server.clients.size;
  }

  /** Request frames received so far (JSON with a numeric `Data.Cmd`), as command ids. */
  get receivedCommands(): number[] {
    return this.received.flatMap((frame) => {
      const cmd = commandOf(frame.payload);
      return cmd === undefined ? [] : [cmd];
    });
  }

  /** Sends one frame (an object is serialized as JSON) to every connected client. */
  push(payload: unknown): void {
    if (this.silent) return;
    const text = typeof payload === "string" ? payload : JSON.stringify(payload);
    for (const client of this.server.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(text);
    }
  }

  /**
   * Pushes the printer-side frames of a fixture that are not responses (status
   * and attributes pushes), in recorded order. Responses are not replayed:
   * the fake answers each request itself so RequestIDs match.
   */
  replay(fixture: Fixture, filter: (frame: FixtureFrame) => boolean = () => true): number {
    let count = 0;
    for (const frame of fixture.frames) {
      if (frame.direction !== "received" || isResponse(frame.payload) || !filter(frame)) continue;
      this.push(frame.payload);
      count++;
    }
    return count;
  }

  /** Resolves with the next received frame that matches `predicate`. */
  nextFrame(predicate: (frame: ReceivedFrame) => boolean = () => true): Promise<ReceivedFrame> {
    return new Promise((resolve) => {
      const listener = (frame: ReceivedFrame) => {
        if (!predicate(frame)) return;
        this.frameListeners.delete(listener);
        resolve(frame);
      };
      this.frameListeners.add(listener);
    });
  }

  /** Calls `listener` with every frame received from now on; returns a function that stops it. */
  onFrame(listener: (frame: ReceivedFrame) => void): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  /** Resolves once a client is connected. */
  async waitForClient(): Promise<void> {
    if (this.clientCount > 0) return;
    await new Promise<void>((resolve) => this.server.once("connection", () => resolve()));
  }

  /**
   * Stops answering requests and pushing frames while keeping every connection
   * open, as a printer that lost power or Wi-Fi without closing would. Frames
   * are still recorded. `goSilent(false)` answers and pushes again.
   */
  goSilent(silent = true): void {
    this.silent = silent;
  }

  /** Drops every client connection abruptly, as a printer reboot would. */
  dropClients(): void {
    for (const client of this.server.clients) client.terminate();
  }

  /** Stops the server and drops every client. */
  async close(): Promise<void> {
    this.dropClients();
    await new Promise<void>((resolve, reject) => this.server.close((error) => (error ? reject(error) : resolve())));
  }

  private answer(socket: WebSocket, payload: unknown): void {
    const cmd = commandOf(payload);
    if (cmd === undefined || this.silent) return;
    const reply = this.replies.get(cmd) ?? 0;
    if (reply === "silent") return;
    const request = (payload as { Data: { RequestID?: unknown; Data?: unknown } }).Data;
    const requestData = typeof request.Data === "object" && request.Data !== null ? (request.Data as Record<string, unknown>) : {};
    socket.send(
      JSON.stringify({
        Id: RESPONSE_ID,
        Data: {
          Cmd: cmd,
          Data: typeof reply === "function" ? reply(requestData) : { Ack: reply },
          RequestID: typeof request.RequestID === "string" ? request.RequestID : "",
          MainboardID: FIXTURE_MAINBOARD_ID,
          TimeStamp: Math.floor(Date.now() / 1000),
        },
        Topic: `sdcp/response/${FIXTURE_MAINBOARD_ID}`,
      }),
    );
  }
}

/** Host for a URL to a server listening on `host`: loopback for a wildcard address. */
export function urlHost(host: string): string {
  if (host === "0.0.0.0" || host === "::") return "127.0.0.1";
  return host.includes(":") ? `[${host}]` : host;
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function commandOf(payload: unknown): number | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const data = (payload as { Data?: unknown }).Data;
  if (typeof data !== "object" || data === null) return undefined;
  const cmd = (data as { Cmd?: unknown }).Cmd;
  return typeof cmd === "number" ? cmd : undefined;
}

function isResponse(payload: unknown): boolean {
  const topic = typeof payload === "object" && payload !== null ? (payload as { Topic?: unknown }).Topic : undefined;
  return typeof topic === "string" && topic.startsWith("sdcp/response/");
}
