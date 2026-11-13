// Camera proxy (design D5): one upstream MJPEG connection to the printer,
// fanned out to every browser watching. The upstream opens with the first
// viewer and closes when the last one leaves, so the printer never serves
// more than one stream to this service.
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
}

/** Shares one upstream MJPEG stream between any number of viewers. */
export class CameraProxy {
  private readonly options: CameraProxyOptions;
  private readonly logger: Logger;
  private readonly maxBacklogBytes: number;
  private readonly responseTimeoutMs: number;
  private readonly viewers = new Set<Viewer>();
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
  handle(_req: IncomingMessage, res: ServerResponse): void {
    const viewer: Viewer = { res, started: false };
    this.viewers.add(viewer);
    res.on("close", () => this.detach(viewer));
    if (this.upstream !== undefined) this.sendHead(viewer, this.upstream.headers);
    else if (!this.upstreamOpen) void this.connect();
  }

  /** Drops every viewer and the upstream. */
  close(): void {
    for (const viewer of this.viewers) viewer.res.destroy();
    this.viewers.clear();
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
    viewer.res.writeHead(200, {
      "Content-Type": headers["content-type"] ?? "multipart/x-mixed-replace",
      "Cache-Control": "no-cache, no-store",
      Connection: "close",
    });
  }

  /**
   * Writes a chunk to every viewer. A viewer that joined mid-stream starts at
   * the next part delimiter, so its first part is whole.
   */
  private fanOut(chunk: Buffer): void {
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

  private detach(viewer: Viewer): void {
    this.viewers.delete(viewer);
    if (this.viewers.size === 0) this.closeUpstream();
  }

  /** Ends every viewer (502 for those without headers yet) and the upstream. */
  private fail(reason: string): void {
    this.logger.warn(`camera: ${reason}`);
    const viewers = [...this.viewers];
    this.viewers.clear();
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
  return boundary === undefined ? null : Buffer.from(`--${boundary}`);
}
