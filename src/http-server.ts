// HTTP API for the dashboard (design D3, D4, D5): the status snapshot, a
// Server-Sent Events stream of snapshot changes, the control command
// endpoint, the camera proxy, and the dashboard's static files. When an access
// token is configured, every API and camera route requires it, as a bearer
// header or, for clients that cannot set headers (EventSource, <img>), as a
// `token` query parameter. The dashboard's files hold no printer data and are
// served without it.
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { StaticFiles } from "./dashboard-files.ts";
import { type CommandResult, ControlRejectedError } from "./print-control.ts";
import { type Logger, NotConnectedError } from "./sdcp-client.ts";
import type { StatusSnapshot } from "./status-store.ts";

/** The status store as the server reads it. */
export interface SnapshotSource {
  readonly snapshot: StatusSnapshot;
  on(event: "change", listener: (snapshot: StatusSnapshot) => void): unknown;
  off(event: "change", listener: (snapshot: StatusSnapshot) => void): unknown;
}

/** The print control commands (a PrintControl). */
export interface Controls {
  pause(): Promise<CommandResult>;
  resume(): Promise<CommandResult>;
  stop(options: { confirm?: boolean }): Promise<CommandResult>;
  setLight(on: boolean): Promise<CommandResult>;
}

export interface ApiServerOptions {
  store: SnapshotSource;
  control: Controls;
  /** Access token; null means no token check. */
  token: string | null;
  /** Serves `GET /camera` (a CameraProxy); without it the route does not exist. */
  camera?: { handle(req: IncomingMessage, res: ServerResponse): void };
  /** The dashboard's files, served on GET without the token; without it there is no dashboard. */
  dashboard?: StaticFiles;
  logger?: Logger;
  /** Interval of SSE keep-alive comments. 15 s by default. */
  keepAliveMs?: number;
  /** An SSE client whose unsent backlog grows past this many bytes is dropped. 1 MiB by default. */
  maxEventBacklogBytes?: number;
  /** SSE clients served at once; more answer 503. 32 by default. */
  maxEventClients?: number;
}

/** Largest accepted command body, in bytes. */
const MAX_BODY_BYTES = 4096;

/** Error codes in `{"error": {"code", "message"}}` bodies. */
export type ApiErrorCode =
  | "unauthorized"
  | "not-found"
  | "method-not-allowed"
  | "bad-request"
  | "confirmation-required"
  | "not-allowed"
  | "not-connected"
  | "too-many-clients"
  | "internal";

class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  constructor(status: number, code: ApiErrorCode, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

type Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => void | Promise<void>;

/** Creates (but does not start) the API server. */
export function createApiServer(options: ApiServerOptions): Server {
  const logger = options.logger ?? console;
  const events: EventStreamLimits = {
    keepAliveMs: options.keepAliveMs ?? 15_000,
    maxBacklogBytes: options.maxEventBacklogBytes ?? 1024 * 1024,
    maxClients: options.maxEventClients ?? 32,
    clients: 0,
  };
  const routes: Record<string, Partial<Record<string, Handler>>> = {
    "/api/status": { GET: (_req, res) => sendJson(res, 200, options.store.snapshot) },
    "/api/events": { GET: (req, res) => streamEvents(req, res, options.store, events, logger) },
    "/api/command": { POST: (req, res) => runCommand(req, res, options.control) },
  };
  const camera = options.camera;
  if (camera !== undefined) routes["/camera"] = { GET: (req, res) => camera.handle(req, res) };

  return createServer((req, res) => {
    // Everything runs inside the async function, so a synchronous throw
    // (even from parsing a malformed request-target) becomes an error answer
    // instead of an uncaught exception that ends the process.
    let path = "-";
    void (async () => {
      const url = parseTarget(req.url);
      path = url.pathname;
      if (options.dashboard?.has(url.pathname) && req.method === "GET") {
        await options.dashboard.serve(url.pathname, res);
        return;
      }
      if (!authorized(req, url, options.token)) {
        res.setHeader("WWW-Authenticate", 'Bearer realm="printer"');
        throw new ApiError(401, "unauthorized", "missing or wrong access token");
      }
      const route = routes[url.pathname];
      if (route === undefined) throw new ApiError(404, "not-found", `no route ${url.pathname}`);
      const handler = route[req.method ?? "GET"];
      if (handler === undefined) {
        res.setHeader("Allow", Object.keys(route).join(", "));
        throw new ApiError(405, "method-not-allowed", `${req.method} is not allowed on ${url.pathname}`);
      }
      await handler(req, res, url);
    })().catch((error: unknown) => {
      try {
        const apiError = toApiError(error);
        if (apiError.status === 500) logger.error(`${req.method} ${path} failed: ${(error as Error)?.stack ?? error}`);
        if (res.headersSent) {
          res.destroy();
          return;
        }
        sendJson(res, apiError.status, { error: { code: apiError.code, message: apiError.message } });
      } catch {
        res.destroy();
      }
    });
  });
}

/** The request-target as a URL; a target that is not one answers 400. */
function parseTarget(target: string | undefined): URL {
  try {
    return new URL(target ?? "/", "http://localhost");
  } catch {
    throw new ApiError(400, "bad-request", "request target is not a valid URL");
  }
}

/**
 * Whether the request carries the configured token, as `Authorization:
 * Bearer <token>` or `?token=<token>`. Always true without a token.
 */
export function authorized(req: IncomingMessage, url: URL, token: string | null): boolean {
  if (token === null) return true;
  const header = req.headers.authorization;
  const bearer = header?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  return [bearer, url.searchParams.get("token") ?? undefined].some((given) => given !== undefined && sameToken(given, token));
}

/** Constant-time comparison (hashing first makes the lengths equal). */
function sameToken(given: string, expected: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

interface EventStreamLimits {
  keepAliveMs: number;
  maxBacklogBytes: number;
  maxClients: number;
  /** SSE clients currently connected. */
  clients: number;
}

/**
 * Sends the current snapshot, then every change, as `status` events. A client
 * that does not read is dropped once its backlog passes the limit, so it
 * cannot grow server memory without bound.
 */
function streamEvents(req: IncomingMessage, res: ServerResponse, store: SnapshotSource, limits: EventStreamLimits, logger: Logger): void {
  if (limits.clients >= limits.maxClients) {
    throw new ApiError(503, "too-many-clients", `at most ${limits.maxClients} event streams at once`);
  }
  limits.clients++;
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const write = (text: string) => {
    if (res.destroyed) return;
    res.write(text);
    if (res.writableLength > limits.maxBacklogBytes) {
      logger.warn("events: dropping a client that cannot keep up");
      res.destroy();
    }
  };
  const send = (snapshot: StatusSnapshot) => write(`event: status\ndata: ${JSON.stringify(snapshot)}\n\n`);
  const keepAlive = setInterval(() => write(": keep-alive\n\n"), limits.keepAliveMs);
  keepAlive.unref();
  req.socket.setTimeout(0);
  res.on("close", () => {
    limits.clients--;
    clearInterval(keepAlive);
    store.off("change", send);
  });
  store.on("change", send);
  send(store.snapshot);
}

/**
 * Runs one control command from a JSON body: `{"action": "pause"}`,
 * `{"action": "resume"}`, `{"action": "stop", "confirm": true}`, or
 * `{"action": "light", "on": true|false}`. A sent command answers 200 with its
 * result, whatever the outcome.
 */
async function runCommand(req: IncomingMessage, res: ServerResponse, control: Controls): Promise<void> {
  const body = await readJson(req);
  let result: Promise<CommandResult>;
  switch (body.action) {
    case "pause":
      result = control.pause();
      break;
    case "resume":
      result = control.resume();
      break;
    case "stop":
      result = control.stop({ confirm: body.confirm === true });
      break;
    case "light":
      if (typeof body.on !== "boolean") throw new ApiError(400, "bad-request", 'light needs "on": true or false');
      result = control.setLight(body.on);
      break;
    default:
      throw new ApiError(400, "bad-request", 'action must be one of "pause", "resume", "stop", "light"');
  }
  sendJson(res, 200, await result);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const type = req.headers["content-type"] ?? "";
  if (!/^application\/json\b/i.test(type)) throw new ApiError(400, "bad-request", "body must be application/json");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new ApiError(400, "bad-request", `body is larger than ${MAX_BODY_BYTES} bytes`);
    chunks.push(chunk);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError(400, "bad-request", "body is not valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ApiError(400, "bad-request", "body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof ControlRejectedError) {
    return error.reason === "confirmation-required"
      ? new ApiError(400, "confirmation-required", error.message)
      : new ApiError(409, "not-allowed", error.message);
  }
  if (error instanceof NotConnectedError) return new ApiError(503, "not-connected", error.message);
  return new ApiError(500, "internal", "internal error");
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(text) });
  res.end(text);
}
