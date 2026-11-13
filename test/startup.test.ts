import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "ecc-startup-"));
after(() => rmSync(dir, { recursive: true, force: true }));

describe("node src/main.ts", () => {
  it("exits non-zero on 0.0.0.0 without a token and says what to set", async () => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("../src/main.ts", import.meta.url))], {
      env: {
        PATH: process.env.PATH,
        CONFIG_PATH: join(dir, "missing.json"),
        LISTEN_HOST: "0.0.0.0",
        PRINTER_IP: "192.0.2.10",
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
    for (const name of ["0.0.0.0", "ACCESS_TOKEN", "LISTEN_HOST"]) assert.ok(stderr.includes(name), `stderr names ${name}: ${stderr}`);
  });
});
