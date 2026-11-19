import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { UDP_ATTEMPT_MARKER } from "./support/no-udp.ts";

const dir = mkdtempSync(join(tmpdir(), "ecc-startup-"));
const readOnlyDir = join(dir, "read-only");
mkdirSync(readOnlyDir);
after(() => {
  chmodSync(readOnlyDir, 0o700);
  rmSync(dir, { recursive: true, force: true });
});

describe("node src/main.ts", () => {
  // No PRINTER_IP, so main.ts would run UDP discovery if it got that far. The
  // preload makes any UDP socket print a marker and throw instead of sending,
  // so the refusal must come before discovery, not from startService after it.
  it("refuses 0.0.0.0 without a token before discovery, and says what to set", async () => {
    const preload = new URL("./support/no-udp.ts", import.meta.url).href;
    const child = spawn(process.execPath, ["--import", preload, fileURLToPath(new URL("../src/main.ts", import.meta.url))], {
      env: {
        PATH: process.env.PATH,
        CONFIG_PATH: join(dir, "missing.json"),
        LISTEN_HOST: "0.0.0.0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.stdout.resume();

    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) =>
      child.once("exit", (exitCode, exitSignal) => resolve([exitCode, exitSignal])),
    );
    clearTimeout(timer);

    assert.equal(signal, null, "exited on its own within 5 s");
    assert.notEqual(code, 0);
    assert.ok(!stderr.includes(UDP_ATTEMPT_MARKER), `no discovery attempted: ${stderr}`);
    for (const name of ["0.0.0.0", "ACCESS_TOKEN", "LISTEN_HOST"]) assert.ok(stderr.includes(name), `stderr names ${name}: ${stderr}`);
  });

  it("creates ./data and the archive in it when neither dataDir nor DATA_DIR is set", async () => {
    const cwd = join(dir, "default-location");
    mkdirSync(cwd);
    // A free port: listen on 0, read the port, and release it for the service.
    const probe = createServer().listen(0, "127.0.0.1");
    await new Promise((resolve) => probe.once("listening", resolve));
    const { port } = probe.address() as { port: number };
    await new Promise((resolve) => probe.close(resolve));

    const child = spawn(process.execPath, [fileURLToPath(new URL("../src/main.ts", import.meta.url))], {
      cwd,
      env: {
        PATH: process.env.PATH,
        CONFIG_PATH: join(dir, "missing.json"),
        // Nothing listens on 127.0.0.1:3030 in the tests: the session only retries in the background.
        PRINTER_IP: "127.0.0.1",
        LISTEN_HOST: "127.0.0.1",
        LISTEN_PORT: String(port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
    const exited = new Promise<[number | null, NodeJS.Signals | null]>((resolve) =>
      child.once("exit", (exitCode, exitSignal) => resolve([exitCode, exitSignal])),
    );
    try {
      for (let i = 0; i < 500 && !output.includes("API on http://"); i++) {
        if (child.exitCode !== null) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(output.includes("API on http://"), `the service started: ${output}`);
      assert.ok(existsSync(join(cwd, "data", "history.sqlite")), "./data/history.sqlite exists");
    } finally {
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      await exited;
      clearTimeout(timer);
    }
  });

  it(
    "exits non-zero naming the data directory and DATA_DIR when it cannot write there",
    { skip: process.getuid?.() === 0 ? "root can write a read-only directory" : false },
    async () => {
      const dataDir = readOnlyDir;
      chmodSync(dataDir, 0o500);
      const child = spawn(process.execPath, [fileURLToPath(new URL("../src/main.ts", import.meta.url))], {
        env: {
          PATH: process.env.PATH,
          CONFIG_PATH: join(dir, "missing.json"),
          PRINTER_IP: "127.0.0.1",
          LISTEN_HOST: "127.0.0.1",
          DATA_DIR: dataDir,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
      child.stdout.resume();

      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) =>
        child.once("exit", (exitCode, exitSignal) => resolve([exitCode, exitSignal])),
      );
      clearTimeout(timer);

      assert.equal(signal, null, "exited on its own within 5 s");
      assert.notEqual(code, 0);
      for (const name of [dataDir, "DATA_DIR"]) assert.ok(stderr.includes(name), `stderr names ${name}: ${stderr}`);
    },
  );
});
