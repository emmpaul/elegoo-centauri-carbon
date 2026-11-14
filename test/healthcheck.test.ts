import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { type IncomingHttpHeaders, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/healthcheck.ts", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "ecc-healthcheck-"));
after(() => rmSync(dir, { recursive: true, force: true }));

interface Seen {
  url: string | undefined;
  headers: IncomingHttpHeaders;
}

/** A stand-in for the service that answers every request with `status`. */
async function fakeService(status: number): Promise<{ port: number; seen: Seen[]; close(): Promise<void> }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    res.writeHead(status, { "content-type": "application/json" }).end("{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    port: (server.address() as AddressInfo).port,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Runs the health check with only the given env (and PATH); resolves with its exit code and stderr. */
async function runHealthcheck(env: Record<string, string>): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(process.execPath, [script], {
    env: { PATH: process.env.PATH, CONFIG_PATH: join(dir, "missing.json"), ...env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  const [code] = (await once(child, "exit")) as [number | null];
  clearTimeout(timer);
  return { code, stderr };
}

describe("scripts/healthcheck.ts", () => {
  let service: Awaited<ReturnType<typeof fakeService>> | undefined;
  afterEach(async () => {
    await service?.close();
    service = undefined;
  });

  it("exits 0 on a 200 from /api/status and sends the bearer token when ACCESS_TOKEN is set", async () => {
    service = await fakeService(200);
    const result = await runHealthcheck({ LISTEN_HOST: "127.0.0.1", LISTEN_PORT: String(service.port), ACCESS_TOKEN: "s3cret" });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(service.seen.length, 1);
    assert.equal(service.seen[0]?.url, "/api/status");
    assert.equal(service.seen[0]?.headers.authorization, "Bearer s3cret");
  });

  it("sends no authorization header without a token", async () => {
    service = await fakeService(200);
    const result = await runHealthcheck({ LISTEN_HOST: "127.0.0.1", LISTEN_PORT: String(service.port) });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(service.seen[0]?.headers.authorization, undefined);
  });

  it("probes a wildcard listen host on 127.0.0.1", async () => {
    service = await fakeService(200);
    const result = await runHealthcheck({ LISTEN_HOST: "0.0.0.0", LISTEN_PORT: String(service.port), ACCESS_TOKEN: "s3cret" });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(service.seen.length, 1);
  });

  for (const status of [401, 500]) {
    it(`exits 1 when /api/status answers ${status}`, async () => {
      service = await fakeService(status);
      const result = await runHealthcheck({ LISTEN_HOST: "127.0.0.1", LISTEN_PORT: String(service.port), ACCESS_TOKEN: "s3cret" });
      assert.equal(result.code, 1);
      assert.ok(result.stderr.includes(String(status)), result.stderr);
    });
  }

  it("exits 1 when nothing listens on the port", async () => {
    const closed = await fakeService(200);
    const port = closed.port;
    await closed.close();
    const result = await runHealthcheck({ LISTEN_HOST: "127.0.0.1", LISTEN_PORT: String(port) });
    assert.equal(result.code, 1);
    assert.ok(result.stderr.includes("unhealthy"), result.stderr);
  });
});
