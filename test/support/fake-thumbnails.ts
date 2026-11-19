// Test-only fake of the printer's thumbnail server: an HTTP server on
// http://127.0.0.1:<port> that answers `/board-resource/history_image/<id>.png`
// from a function and counts the requests it gets (host and port can be fixed,
// for scripts that stand in for the real printer). It never talks to a real
// printer.
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { urlHost } from "./fake-printer.ts";

const PATH = /^\/board-resource\/history_image\/([^/]+)\.png$/;

/** What the fake answers for one thumbnail. */
export interface ThumbnailAnswer {
  /** 200 by default. */
  status?: number;
  /** `image/png` by default. */
  contentType?: string;
  body: Uint8Array;
  /** Leave out `Content-Length`, so the body is sent chunked. */
  chunked?: boolean;
}

export interface FakeThumbnailsOptions {
  /** The answer for a task id; undefined answers 404. */
  answer?: (taskId: string) => ThumbnailAnswer | undefined;
  /** Address to listen on. 127.0.0.1 by default. */
  host?: string;
  /**
   * Host the thumbnail URLs name, as the printer names its own address: the
   * address the service reaches it at. `host` by default, and 127.0.0.1 for a
   * wildcard `host`.
   */
  urlHost?: string;
  /** Port to listen on. A free port by default. */
  port?: number;
}

/** A stand-in PNG body (the PNG signature, then a label), not a decodable image. */
export function fakePng(label: string): Buffer {
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(label)]);
}

export class FakeThumbnails {
  /** Requests received so far, for any path. */
  requests = 0;
  /** Requests per task id, for thumbnail paths. */
  readonly requestsFor = new Map<string, number>();
  answer: (taskId: string) => ThumbnailAnswer | undefined;
  private readonly server: Server;
  private readonly host: string;

  private constructor(server: Server, options: FakeThumbnailsOptions) {
    this.server = server;
    this.host = urlHost(options.urlHost ?? options.host ?? "127.0.0.1");
    this.answer = options.answer ?? ((taskId) => ({ body: fakePng(taskId) }));
    server.on("request", (req: IncomingMessage, res: ServerResponse) => this.serve(req, res));
  }

  static async start(options: FakeThumbnailsOptions = {}): Promise<FakeThumbnails> {
    const server = createServer();
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1");
    await once(server, "listening");
    return new FakeThumbnails(server, options);
  }

  get port(): number {
    return (this.server.address() as AddressInfo).port;
  }

  /** The thumbnail URL the printer reports for a task id, pointing at this fake. */
  urlFor(taskId: string): string {
    return `http://${this.host}:${this.port}/board-resource/history_image/${taskId}.png`;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private serve(req: IncomingMessage, res: ServerResponse): void {
    this.requests++;
    const match = PATH.exec(req.url ?? "");
    const taskId = match?.[1];
    if (taskId === undefined) {
      res.writeHead(404).end();
      return;
    }
    this.requestsFor.set(taskId, (this.requestsFor.get(taskId) ?? 0) + 1);
    const answer = this.answer(taskId);
    if (answer === undefined) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(answer.status ?? 200, {
      "Content-Type": answer.contentType ?? "image/png",
      ...(answer.chunked ? {} : { "Content-Length": answer.body.byteLength }),
    });
    res.end(answer.body);
  }
}
