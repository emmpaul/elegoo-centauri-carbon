// Test-only fake MJPEG camera: an HTTP server on http://127.0.0.1:<port>/video
// that streams `multipart/x-mixed-replace` parts like the printer's camera on
// port 3031, and counts the connections it gets (host and port can be fixed,
// for scripts that stand in for the real camera). It never talks to a real
// printer.
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { urlHost } from "./fake-printer.ts";

export const FAKE_BOUNDARY = "fakeframe";

/**
 * A stand-in JPEG part body (SOI ... EOI markers around a frame number),
 * padded with `padBytes` zero bytes.
 */
export function fakeJpeg(n: number, padBytes = 0): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from(`frame-${n}`), Buffer.alloc(padBytes), Buffer.from([0xff, 0xd9])]);
}

export interface FakeMjpegOptions {
  /** Interval between frames. 20 ms by default. */
  frameIntervalMs?: number;
  /** Status code to answer with instead of a stream. */
  status?: number;
  /** Zero bytes added to each frame, for tests that need volume. 0 by default. */
  framePadBytes?: number;
  /** Body of part `n`; fakeJpeg (not a decodable image) by default. */
  frame?: (n: number) => Buffer;
  /** Address to listen on. 127.0.0.1 by default. */
  host?: string;
  /** Port to listen on. A free port by default. */
  port?: number;
}

export class FakeMjpegSource {
  /** Connections received so far. */
  connections = 0;
  /** Streams currently open. */
  readonly open = new Set<ServerResponse>();
  status: number;
  private readonly server: Server;
  private readonly frameIntervalMs: number;
  private readonly framePadBytes: number;
  private readonly frame: ((n: number) => Buffer) | undefined;
  private readonly closeListeners = new Set<() => void>();
  private readonly host: string;

  private constructor(server: Server, options: FakeMjpegOptions) {
    this.server = server;
    this.host = urlHost(options.host ?? "127.0.0.1");
    this.status = options.status ?? 200;
    this.frameIntervalMs = options.frameIntervalMs ?? 20;
    this.framePadBytes = options.framePadBytes ?? 0;
    this.frame = options.frame;
    server.on("request", (req: IncomingMessage, res: ServerResponse) => this.serve(req, res));
  }

  static async start(options: FakeMjpegOptions = {}): Promise<FakeMjpegSource> {
    const server = createServer();
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1");
    await once(server, "listening");
    return new FakeMjpegSource(server, options);
  }

  get url(): string {
    return `http://${this.host}:${(this.server.address() as AddressInfo).port}/video`;
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

  /** Ends every open stream, as a camera that stops would. */
  endStreams(): void {
    for (const res of this.open) res.end();
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
      const jpeg = this.frame ? this.frame(n++) : fakeJpeg(n++, this.framePadBytes);
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
