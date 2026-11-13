// Test-only fake ntfy server: an HTTP server on http://127.0.0.1:<port> that
// records every publish request and answers with a chosen status. It never
// talks to ntfy.sh.
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface NtfyRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  /** The body parsed as JSON; undefined when it is not JSON. */
  json: unknown;
}

export class FakeNtfy {
  readonly requests: NtfyRequest[] = [];
  /** Statuses for the next requests, in order; 200 once they run out. */
  readonly statuses: number[] = [];
  private readonly server: Server;

  private constructor(server: Server) {
    this.server = server;
    server.on("request", (request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        this.requests.push({ method: request.method ?? "", path: request.url ?? "", headers: request.headers, body, json: parse(body) });
        const status = this.statuses.shift() ?? 200;
        response.writeHead(status, { "content-type": "application/json" });
        response.end(status === 200 ? JSON.stringify({ id: `m${this.requests.length}`, event: "message" }) : '{"error":"fake"}');
      });
    });
  }

  /** Starts a fake ntfy server on a free port on 127.0.0.1. */
  static async start(): Promise<FakeNtfy> {
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return new FakeNtfy(server);
  }

  get url(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
