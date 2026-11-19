// Camera proxy (design D5): one upstream MJPEG connection to the printer,
// fanned out to every browser watching. The upstream opens with the first
// viewer and closes when the last one leaves, so the printer never serves
// more than one stream to this service. A frame taker (`takeFrame`, for the
// notification Photo) holds the same upstream for one part without counting
// as a viewer.
import { get, type ClientRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import type { Logger } from "./sdcp-client.ts";

export interface CameraProxyOptions {
  /** Upstream MJPEG URL, e.g. `http://192.168.0.96:3031/video`. */
  url: string;
  logger?: Logger;
  /**
   * Runs before each upstream connection (the service asks the printer to
   * enable streaming, Cmd 386). A failure is logged and the connection is
   * tried anyway.
   */
  beforeConnect?: () => Promise<unknown>;
  /** A viewer whose unsent backlog grows past this many bytes is dropped. 4 MiB by default. */
  maxBacklogBytes?: number;
  /**
   * The camera counts as unavailable when it has not answered (connected and
   * sent its response headers) within this many milliseconds. 10 s by default,
   * the dashboard's own stall limit.
   */
  responseTimeoutMs?: number;
}

interface Viewer {
  res: ServerResponse;
  /** True once the viewer gets bytes; it starts at a part boundary. */
  started: boolean;
  /**
   * Asked for `application/octet-stream`: the same bytes under that type.
   * WebKit's network layer splits a `multipart/x-mixed-replace` response
   * itself, so `fetch()` there never sees the stream as sent (the dashboard
   * on iOS and Safari showed no frame); an `<img>` keeps the multipart type.
   */
  raw: boolean;
}

/** A Photo frame is rejected once its part grows past this many bytes. */
const MAX_FRAME_BYTES = 8 * 1024 * 1024;

/** Room for a part's headers on top of the frame cap. */
const MAX_PART_HEADER_BYTES = 64 * 1024;

const CRLF = Buffer.from("\r\n");
const HEADER_END = Buffer.from("\r\n\r\n");

interface FrameTaker {
  /** True once `after` has settled; only parts whose delimiter arrives later count. */
  armed: boolean;
  /** True once the delimiter that starts the taken part has arrived. */
  inPart: boolean;
  /** Bytes of the part so far (after its delimiter). */
  chunks: Buffer[];
  size: number;
  /** Last bytes seen, for a delimiter split across chunks. */
  tail: Buffer;
  resolve: (frame: Buffer) => void;
  reject: (error: Error) => void;
}

/** Shares one upstream MJPEG stream between any number of viewers. */
export class CameraProxy {
  private readonly options: CameraProxyOptions;
  private readonly logger: Logger;
  private readonly maxBacklogBytes: number;
  private readonly responseTimeoutMs: number;
  private readonly viewers = new Set<Viewer>();
  private readonly takers = new Set<FrameTaker>();
  /** Bumped on every connect and close; callbacks of an older connection do nothing. */
  private generation = 0;
  private connecting = false;
  private request: ClientRequest | undefined;
  private upstream: IncomingMessage | undefined;
  /** Delimiter (`--<boundary>`) of the upstream stream; null when it has none. */
  private delimiter: Buffer | null = null;
  /** Last bytes of the previous chunk, for a delimiter split across chunks. */
  private tail: Buffer = Buffer.alloc(0);
  private connections = 0;
  /** Fails the connection when the camera has not answered in time. */
  private responseTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: CameraProxyOptions) {
    this.options = options;
    this.logger = options.logger ?? console;
    this.maxBacklogBytes = options.maxBacklogBytes ?? 4 * 1024 * 1024;
    this.responseTimeoutMs = options.responseTimeoutMs ?? 10_000;
  }

  /** Number of viewers currently attached. */
  get viewerCount(): number {
    return this.viewers.size;
  }

  /** Whether an upstream connection is open or opening. */
  get upstreamOpen(): boolean {
    return this.connecting || this.request !== undefined;
  }

  /** Upstream connections opened so far. */
  get upstreamConnections(): number {
    return this.connections;
  }

  /** Attaches a viewer; answers 502 when the camera cannot be reached. */
  handle(req: IncomingMessage, res: ServerResponse): void {
    const raw = /\bapplication\/octet-stream\b/i.test(req.headers.accept ?? "");
    const viewer: Viewer = { res, started: false, raw };
    this.viewers.add(viewer);
    res.on("close", () => this.detach(viewer));
    if (this.upstream !== undefined) this.sendHead(viewer, this.upstream.headers);
    else if (!this.upstreamOpen) void this.connect();
  }

  /**
   * Resolves with the next whole JPEG part of the upstream stream, opened for
   * it when nothing holds it. Only a part whose delimiter arrives after
   * `after` settles counts. Rejects when `signal` aborts, the upstream fails,
   * the stream has no multipart boundary, or the part is not a JPEG or is
   * larger than 8 MiB.
   */
  takeFrame(options: { signal: AbortSignal; after?: Promise<unknown> }): Promise<Buffer> {
    const { signal, after } = options;
    if (signal.aborted) return Promise.reject(new Error("photo timed out"));
    if (this.upstream !== undefined && this.delimiter === null) {
      return Promise.reject(new Error("camera stream has no multipart boundary"));
    }
    return new Promise<Buffer>((resolve, reject) => {
      const onAbort = () => taker.reject(new Error("photo timed out"));
      const settle = () => {
        signal.removeEventListener("abort", onAbort);
        this.takers.delete(taker);
        this.releaseUpstream();
      };
      const taker: FrameTaker = {
        armed: after === undefined,
        inPart: false,
        chunks: [],
        size: 0,
        tail: Buffer.alloc(0),
        resolve: (frame) => {
          if (!this.takers.has(taker)) return;
          settle();
          resolve(frame);
        },
        reject: (error) => {
          if (!this.takers.has(taker)) return;
          settle();
          reject(error);
        },
      };
      this.takers.add(taker);
      signal.addEventListener("abort", onAbort, { once: true });
      if (after !== undefined) {
        const arm = () => {
          taker.armed = true;
        };
        after.then(arm, arm);
      }
      if (!this.upstreamOpen) void this.connect();
    });
  }

  /** Drops every viewer, every frame taker, and the upstream. */
  close(): void {
    for (const viewer of this.viewers) viewer.res.destroy();
    this.viewers.clear();
    for (const taker of [...this.takers]) taker.reject(new Error("camera proxy closed"));
    this.closeUpstream();
  }

  private async connect(): Promise<void> {
    const generation = ++this.generation;
    this.connecting = true;
    if (this.options.beforeConnect) {
      try {
        await this.options.beforeConnect();
      } catch (error) {
        this.logger.warn(`camera: preparing the stream failed: ${(error as Error).message}`);
      }
    }
    if (generation !== this.generation) return; // closed meanwhile
    this.connecting = false;
    this.connections++;
    const current = () => generation === this.generation;
    const request = get(this.options.url, (upstream) => {
      clearTimeout(this.responseTimer);
      if (!current()) {
        upstream.destroy();
        return;
      }
      if (upstream.statusCode !== 200) {
        upstream.resume();
        this.fail(`camera answered HTTP ${upstream.statusCode}`);
        return;
      }
      this.upstream = upstream;
      this.delimiter = delimiterOf(upstream.headers["content-type"]);
      this.tail = Buffer.alloc(0);
      if (this.delimiter === null) {
        for (const taker of [...this.takers]) taker.reject(new Error("camera stream has no multipart boundary"));
        if (!current()) return; // nothing else held the upstream
      }
      for (const viewer of this.viewers) this.sendHead(viewer, upstream.headers);
      upstream.on("data", (chunk: Buffer) => this.fanOut(chunk));
      upstream.on("end", () => {
        if (current()) this.fail("camera stream ended");
      });
      upstream.on("error", (error) => {
        if (current()) this.fail(`camera stream failed: ${error.message}`);
      });
    });
    this.request = request;
    this.responseTimer = setTimeout(() => {
      if (current()) this.fail(`camera did not answer within ${this.responseTimeoutMs} ms`);
    }, this.responseTimeoutMs);
    request.on("error", (error) => {
      if (current()) this.fail(`camera unreachable: ${error.message}`);
    });
  }

  private sendHead(viewer: Viewer, headers: IncomingHttpHeaders): void {
    if (viewer.res.headersSent) return;
    const type = headers["content-type"] ?? "multipart/x-mixed-replace";
    viewer.res.writeHead(200, {
      "Content-Type": viewer.raw ? type.replace(/^[^;]*/, "application/octet-stream") : type,
      "Cache-Control": "no-cache, no-store",
      Connection: "close",
    });
  }

  /**
   * Writes a chunk to every viewer. A viewer that joined mid-stream starts at
   * the next part delimiter, so its first part is whole.
   */
  private fanOut(chunk: Buffer): void {
    if (this.takers.size > 0) this.feedTakers(chunk);
    const withTail = this.delimiter === null ? chunk : Buffer.concat([this.tail, chunk]);
    let start: number | undefined;
    for (const viewer of this.viewers) {
      if (!viewer.res.headersSent) continue;
      if (viewer.started) {
        this.write(viewer, chunk);
        continue;
      }
      start ??= this.delimiter === null ? 0 : withTail.indexOf(this.delimiter);
      if (start === -1) continue;
      viewer.started = true;
      this.write(viewer, this.delimiter === null ? chunk : withTail.subarray(start));
    }
    if (this.delimiter !== null) this.tail = withTail.subarray(Math.max(0, withTail.length - (this.delimiter.length - 1)));
  }

  private write(viewer: Viewer, chunk: Buffer): void {
    viewer.res.write(chunk);
    if (viewer.res.writableLength > this.maxBacklogBytes) {
      this.logger.warn("camera: dropping a viewer that cannot keep up");
      viewer.res.destroy();
    }
  }

  /**
   * Cuts the first part whose delimiter arrives after a taker is armed, up to
   * the next delimiter, and hands its body (part headers and the trailing
   * CRLF removed) to the taker.
   */
  private feedTakers(chunk: Buffer): void {
    const delimiter = this.delimiter;
    if (delimiter === null) return;
    for (const taker of [...this.takers]) {
      if (!taker.armed) continue;
      const search = Buffer.concat([taker.tail, chunk]);
      if (!taker.inPart) {
        const start = search.indexOf(delimiter);
        if (start === -1) {
          taker.tail = search.subarray(Math.max(0, search.length - (delimiter.length - 1)));
          continue;
        }
        taker.inPart = true;
        const rest = search.subarray(start + delimiter.length);
        taker.chunks = [rest];
        taker.size = rest.length;
        taker.tail = Buffer.alloc(0);
        this.finishPart(taker, rest, delimiter);
        continue;
      }
      taker.chunks.push(chunk);
      taker.size += chunk.length;
      this.finishPart(taker, search, delimiter);
    }
  }

  /**
   * Looks for the closing delimiter in `search`, the newest bytes of the part
   * so far (it ends where the part so far ends), and settles the taker once
   * the part is whole.
   */
  private finishPart(taker: FrameTaker, search: Buffer, delimiter: Buffer): void {
    const end = search.indexOf(delimiter);
    if (end === -1) {
      if (taker.size > MAX_FRAME_BYTES + MAX_PART_HEADER_BYTES) {
        taker.reject(new Error("camera frame is larger than 8 MiB"));
        return;
      }
      taker.tail = search.subarray(Math.max(0, search.length - (delimiter.length - 1)));
      return;
    }
    const part = Buffer.concat(taker.chunks).subarray(0, taker.size - (search.length - end));
    const headerEnd = part.indexOf(HEADER_END);
    let body = headerEnd === -1 ? part : part.subarray(headerEnd + HEADER_END.length);
    if (body.subarray(body.length - CRLF.length).equals(CRLF)) body = body.subarray(0, body.length - CRLF.length);
    if (body.length > MAX_FRAME_BYTES) taker.reject(new Error("camera frame is larger than 8 MiB"));
    else if (body.length < 2 || body[0] !== 0xff || body[1] !== 0xd8) taker.reject(new Error("camera frame is not a JPEG"));
    else taker.resolve(body);
  }

  private detach(viewer: Viewer): void {
    this.viewers.delete(viewer);
    this.releaseUpstream();
  }

  /** Closes the upstream once no viewer and no frame taker holds it. */
  private releaseUpstream(): void {
    if (this.viewers.size === 0 && this.takers.size === 0) this.closeUpstream();
  }

  /** Ends every viewer (502 for those without headers yet), every frame taker, and the upstream. */
  private fail(reason: string): void {
    this.logger.warn(`camera: ${reason}`);
    const viewers = [...this.viewers];
    this.viewers.clear();
    for (const taker of [...this.takers]) taker.reject(new Error(reason));
    this.closeUpstream();
    for (const { res } of viewers) {
      if (res.headersSent) {
        res.end();
        continue;
      }
      const body = JSON.stringify({ error: { code: "camera-unavailable", message: reason } });
      res.writeHead(502, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
      res.end(body);
    }
  }

  private closeUpstream(): void {
    clearTimeout(this.responseTimer);
    this.generation++;
    this.connecting = false;
    this.upstream?.destroy();
    this.upstream = undefined;
    this.request?.destroy();
    this.request = undefined;
  }
}

/** `--<boundary>` from a multipart content type, or null without one. */
export function delimiterOf(contentType: string | undefined): Buffer | null {
  const match = contentType?.match(/;\s*boundary=(?:"([^"]+)"|([^\s;]+))/i);
  const boundary = match?.[1] ?? match?.[2];
  if (boundary === undefined) return null;
  // The printer's camera already includes the leading dashes (`boundary=--foo`).
  return Buffer.from(boundary.startsWith("--") ? boundary : `--${boundary}`);
}
