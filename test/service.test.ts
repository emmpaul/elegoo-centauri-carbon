import { strict as assert } from "node:assert";
import { connect, createServer } from "node:net";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Logger } from "../src/sdcp-client.ts";
import { type Service, startService } from "../src/service.ts";
import { FakePrinter, loadFixture } from "./support/fake-printer.ts";

function silentLogger(): Logger {
  return { info() {}, warn() {}, error() {} };
}

/** A port that was free a moment ago. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** Whether anything accepts connections on the port. */
async function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

describe("startService listen rule", () => {
  let printer: FakePrinter;
  let service: Service | undefined;

  beforeEach(async () => {
    printer = await FakePrinter.start();
  });

  afterEach(async () => {
    await service?.close();
    service = undefined;
    await printer.close();
  });

  it("rejects 0.0.0.0 without a token and opens no port", async () => {
    const port = await freePort();
    await assert.rejects(
      startService({
        printerUrl: printer.url,
        cameraUrl: "http://127.0.0.1:9/video",
        listen: { host: "0.0.0.0", port },
        token: null,
        logger: silentLogger(),
      }),
      /0\.0\.0\.0.*ACCESS_TOKEN.*LISTEN_HOST/,
    );
    assert.equal(await listening(port), false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(printer.clientCount, 0);
  });

  it("rejects 0.0.0.0 with a whitespace-only token and opens no port", async () => {
    const port = await freePort();
    await assert.rejects(
      startService({
        printerUrl: printer.url,
        cameraUrl: "http://127.0.0.1:9/video",
        listen: { host: "0.0.0.0", port },
        token: "  ",
        logger: silentLogger(),
      }),
      /0\.0\.0\.0.*ACCESS_TOKEN/,
    );
    assert.equal(await listening(port), false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(printer.clientCount, 0);
  });

  it("starts on 127.0.0.1 without a token", async () => {
    service = await startService({
      printerUrl: printer.url,
      cameraUrl: "http://127.0.0.1:9/video",
      listen: { host: "127.0.0.1", port: 0 },
      token: null,
      logger: silentLogger(),
    });
    assert.ok(service.address.port > 0);
    assert.equal(await listening(service.address.port), true);
    await printer.waitForClient();
  });
});

describe("startService history", () => {
  const endedId = "c735768d-8d67-4ae2-8d07-05c0c05c4aa2";
  let printer: FakePrinter;
  let service: Service | undefined;
  let entries: Record<string, unknown>[];

  /** The 26 `HistoryDetailList` entries of `print-complete.json#28`. */
  function fixtureEntries(): Record<string, unknown>[] {
    const frame = loadFixture("print-complete.json").frames.find((f) => f.seq === 28);
    const payload = frame?.payload as { Data: { Data: { HistoryDetailList: Record<string, unknown>[] } } };
    return payload.Data.Data.HistoryDetailList;
  }

  /** Resolves once `check` holds, polling every 10 ms for at most 3 s. */
  async function until(check: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 3000;
    while (!check()) {
      if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  beforeEach(async () => {
    entries = fixtureEntries();
    printer = await FakePrinter.start({ history: { entries } });
    service = await startService({
      printerUrl: printer.url,
      cameraUrl: "http://127.0.0.1:9/video",
      listen: { host: "127.0.0.1", port: 0 },
      token: null,
      logger: silentLogger(),
    });
  });

  afterEach(async () => {
    await service?.close();
    service = undefined;
    await printer.close();
  });

  it("holds the printer's 26 jobs shortly after connecting", async () => {
    await printer.waitForClient();
    printer.replay(loadFixture("connect-idle.json"));
    await until(() => service!.history.list(null, 100).jobs.length === 26, "26 archived jobs");
  });

  it("syncs when a job ends and stores the ended job with its outcome (print-complete.json)", async () => {
    const fixture = loadFixture("print-complete.json");
    // The printer still lists the job as running while it prints (print-complete.json#17).
    const ended = entries[0]!;
    assert.equal(ended.TaskId, endedId);
    const settled = { ...ended };
    Object.assign(ended, { TaskStatus: 4, EndTime: 1794605305, AlreadyPrintLayer: 9 });

    await printer.waitForClient();
    printer.replay(fixture, (frame) => frame.seq === 9);
    await until(() => service!.history.job(endedId)?.outcome === "running", "the running job archived");
    const syncsBefore = printer.receivedCommands.filter((cmd) => cmd === 320).length;

    Object.assign(ended, settled);
    printer.replay(fixture, (frame) => frame.seq > 9);
    await until(() => service!.history.job(endedId)?.outcome === "completed", "the ended job completed");

    // The Cmd 321 that follows the job end's Cmd 320 lists only the ended job.
    const cmdOf = (frame: { payload: unknown }) => (frame.payload as { Data?: { Cmd?: number } }).Data?.Cmd;
    let syncs = 0;
    const endSync = printer.received.findIndex((frame) => cmdOf(frame) === 320 && ++syncs > syncsBefore);
    assert.ok(endSync >= 0, "a sync ran after the job ended");
    const detail = printer.received.slice(endSync).find((frame) => cmdOf(frame) === 321);
    assert.deepEqual((detail?.payload as { Data: { Data: { Id: string[] } } }).Data.Data.Id, [endedId]);
    const job = service!.history.job(endedId)!;
    assert.equal(job.endedAt, 1794605432 * 1000);
    assert.deepEqual(job.layers, { printed: 12, total: 12 });
  });
});
