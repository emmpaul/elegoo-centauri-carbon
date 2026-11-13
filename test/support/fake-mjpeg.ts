// Test-only fake MJPEG camera: an HTTP server on http://127.0.0.1:<port>/video
// that streams `multipart/x-mixed-replace` parts like the printer's camera on
// port 3031, and counts the connections it gets. It never talks to a real
// printer.
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const FAKE_BOUNDARY = "fakeframe";

/** A tiny stand-in JPEG part body (SOI ... EOI markers around a frame number). */
export function fakeJpeg(n: number): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from(`frame-${n}`), Buffer.from([0xff, 0xd9])]);
}

export interface FakeMjpegOptions {
  /** Interval between frames. 20 ms by default. */
  frameIntervalMs?: number;
  /** Status code to answer with instead of a stream. */
  status?: number;
}

export class FakeMjpegSource {
  /** Connections received so far. */
  connections = 0;
  /** Streams currently open. */
  readonly open = new Set<ServerResponse>();
  status: number;
  private readonly server: Server;
  private readonly frameIntervalMs: number;
  private readonly closeListeners = new Set<() => void>();

  private constructor(server: Server, options: FakeMjpegOptions) {
    this.server = server;
    this.status = options.status ?? 200;
    this.frameIntervalMs = options.frameIntervalMs ?? 20;
    server.on("request", (req: IncomingMessage, res: ServerResponse) => this.serve(req, res));
  }

  static async start(options: FakeMjpegOptions = {}): Promise<FakeMjpegSource> {
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return new FakeMjpegSource(server, options);
  }

  get url(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/video`;
  }

  /** Resolves once no stream is open. */
  async waitForNoStreams(): Promise<void> {
    if (this.open.size === 0) return;
    await new Promise<void>((resolve) => {
      const listener = () => {
        if (this.open.size > 0) return;
        this.closeListeners.delete(listener);
        resolve();
      };
      this.closeListeners.add(listener);
    });
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private serve(req: IncomingMessage, res: ServerResponse): void {
    this.connections++;
    if (req.url !== "/video" || this.status !== 200) {
      res.writeHead(req.url !== "/video" ? 404 : this.status).end();
      return;
    }
    res.writeHead(200, { "Content-Type": `multipart/x-mixed-replace; boundary=${FAKE_BOUNDARY}` });
    this.open.add(res);
    let n = 0;
    const timer = setInterval(() => {
      const jpeg = fakeJpeg(n++);
      res.write(`--${FAKE_BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`);
      res.write(jpeg);
      res.write("\r\n");
    }, this.frameIntervalMs);
    res.on("close", () => {
      clearInterval(timer);
      this.open.delete(res);
      for (const listener of this.closeListeners) listener();
    });
  }
}
