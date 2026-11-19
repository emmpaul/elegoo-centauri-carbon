import { strict as assert } from "node:assert";
import { once } from "node:events";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { HistoryStore, jobFromDetail } from "../src/history-store.ts";
import { type HistorySession, HistorySync } from "../src/history-sync.ts";
import { PrinterSession } from "../src/printer-session.ts";
import type { Logger } from "../src/sdcp-client.ts";
import { FakePrinter, type FixtureFrame, type ReceivedFrame, type Reply, loadFixture } from "./support/fake-printer.ts";
import { FakeThumbnails, fakePng } from "./support/fake-thumbnails.ts";

/** The 26 `HistoryDetailList` entries of `print-complete.json#28`. */
function fixtureEntries(): Record<string, unknown>[] {
  const frame = loadFixture("print-complete.json").frames.find((f) => f.seq === 28);
  const payload = frame?.payload as { Data: { Data: { HistoryDetailList: Record<string, unknown>[] } } };
  return payload.Data.Data.HistoryDetailList;
}

const statusPush = (() => {
  const frame = loadFixture("connect-idle.json").frames.find((f: FixtureFrame) =>
    String((f.payload as { Topic?: string }).Topic).startsWith("sdcp/status/"),
  );
  assert.ok(frame, "connect-idle.json has a status push");
  return frame.payload;
})();

interface RecordingLogger extends Logger {
  warnings: string[];
}

function recordingLogger(): RecordingLogger {
  const warnings: string[] = [];
  return { warnings, info() {}, warn: (message) => warnings.push(message), error() {} };
}

/** The fixture thumbnails name 192.0.2.10, not the sync's printer host: one warning per sync. */
const OFF_HOST_WARNING = /^26 history thumbnail\(s\) not fetched: the URL is not http:\/\/ on the printer's host 127\.0\.0\.1 \(first: http:\/\/192\.0\.2\.10\//;

function cmdOf(frame: ReceivedFrame): number | undefined {
  return (frame.payload as { Data?: { Cmd?: number } }).Data?.Cmd;
}

/** The `Id` lists of the Cmd 321 requests the fake received. */
function detailRequests(printer: FakePrinter): string[][] {
  return printer.received
    .filter((frame) => cmdOf(frame) === 321)
    .map((frame) => (frame.payload as { Data: { Data: { Id: string[] } } }).Data.Data.Id);
}

describe("HistorySync", () => {
  let printer: FakePrinter;
  let session: PrinterSession;
  let store: HistoryStore;
  let logger: RecordingLogger;
  let entries: Record<string, unknown>[];

  async function start(replies: Record<number, Reply> = {}) {
    entries = fixtureEntries();
    printer = await FakePrinter.start({ history: { entries }, replies });
    logger = recordingLogger();
    session = new PrinterSession({ url: printer.url, logger, responseTimeoutMs: 300 });
    store = HistoryStore.open(":memory:");
    const online = once(session, "state");
    session.start();
    await printer.waitForClient();
    printer.push(statusPush);
    assert.deepEqual(await online, ["online"]);
  }

  function newSync(): HistorySync {
    // The fixture thumbnails name 192.0.2.10, another host: they are never requested.
    return new HistorySync({ session, store, logger, printerHost: "127.0.0.1" });
  }

  beforeEach(() => {
    entries = [];
  });

  afterEach(async () => {
    session.stop();
    store.close();
    await printer.close();
  });

  it("fills an empty archive with the printer's 26 jobs and emits one change", async () => {
    await start();
    const sync = newSync();
    let changes = 0;
    sync.on("change", () => changes++);
    sync.trigger();
    await sync.idle();
    const page = store.list(null, 100);
    assert.equal(page.jobs.length, 26);
    assert.deepEqual(new Set(page.jobs.map((job) => job.id)), new Set(entries.map((entry) => entry.TaskId)));
    assert.equal(changes, 1);
    assert.deepEqual(detailRequests(printer), [entries.map((entry) => entry.TaskId)]);
    assert.equal(logger.warnings.length, 1);
    assert.match(logger.warnings[0]!, OFF_HOST_WARNING);
  });

  it("keeps the jobs a trimmed printer list no longer has (spec: Printer trims its list)", async () => {
    await start();
    const sync = newSync();
    sync.trigger();
    await sync.idle();
    const before = store.list(null, 100);
    assert.equal(before.jobs.length, 26);
    entries.splice(10);
    sync.trigger();
    await sync.idle();
    assert.deepEqual(store.list(null, 100), before);
  });

  it("asks only for the job stored as running", async () => {
    await start();
    const running = entries[3]!;
    store.upsert(
      entries
        .map((entry) => (entry === running ? { ...entry, TaskStatus: 4 } : entry))
        .map(jobFromDetail)
        .filter((job) => job !== null),
    );
    const sync = newSync();
    let changes = 0;
    sync.on("change", () => changes++);
    sync.trigger();
    await sync.idle();
    assert.deepEqual(detailRequests(printer), [[running.TaskId]]);
    assert.equal(store.job(running.TaskId as string)?.outcome, "completed");
    assert.equal(changes, 1);
  });

  it("emits no change for a sync that stores nothing new", async () => {
    await start();
    const sync = newSync();
    sync.trigger();
    await sync.idle();
    let changes = 0;
    sync.on("change", () => changes++);
    sync.trigger();
    await sync.idle();
    assert.equal(changes, 0);
    assert.equal(detailRequests(printer).length, 1);
  });

  it("runs exactly one more sync for triggers that arrive during a sync", async () => {
    await start();
    const sync = newSync();
    sync.trigger();
    sync.trigger();
    sync.trigger();
    await sync.idle();
    assert.equal(printer.receivedCommands.filter((cmd) => cmd === 320).length, 2);
  });

  it("logs one warning for a silent 320 and leaves the archive and session as they were", async () => {
    await start({ 320: "silent" });
    const states: string[] = [];
    session.on("state", (state) => states.push(state));
    const sync = newSync();
    sync.trigger();
    await sync.idle();
    assert.equal(logger.warnings.filter((message) => message.startsWith("history sync failed")).length, 1);
    assert.match(logger.warnings.at(-1)!, /320/);
    assert.equal(store.list(null, 100).jobs.length, 0);
    assert.equal(session.state, "online");
    assert.deepEqual(states, []);
  });

  it("warns on a non-zero Ack and on a malformed answer, storing nothing", async () => {
    await start({ 320: 2, 321: () => ({ Ack: 0, HistoryDetailList: "nope" }) });
    const sync = newSync();
    sync.trigger();
    await sync.idle();
    assert.match(logger.warnings.at(-1)!, /320 answered Ack 2/);
    printer.replies.delete(320);
    sync.trigger();
    await sync.idle();
    assert.match(logger.warnings.at(-1)!, /321 answered without a HistoryDetailList/);
    printer.replies.set(320, () => ({ Ack: 0, HistoryData: "nope" }));
    sync.trigger();
    await sync.idle();
    assert.match(logger.warnings.at(-1)!, /320 answered without a HistoryData list/);
    printer.replies.set(320, () => ({ Ack: "1\nforged: line" }));
    sync.trigger();
    await sync.idle();
    assert.match(logger.warnings.at(-1)!, /320 answered Ack 1\\u000aforged: line/);
    assert.doesNotMatch(logger.warnings.at(-1)!, /\n/);
    assert.equal(logger.warnings.length, 4);
    assert.equal(store.list(null, 100).jobs.length, 0);
    assert.equal(session.state, "online");
  });

  it("skips entries without a TaskId and stores the rest", async () => {
    await start({
      321: (data) => ({
        Ack: 0,
        HistoryDetailList: [
          { TaskName: "/local/test-print-99.gcode", TaskStatus: 1 },
          ...entries.filter((entry) => (data.Id as string[]).includes(entry.TaskId as string)),
        ],
      }),
    });
    const sync = newSync();
    sync.trigger();
    await sync.idle();
    assert.equal(store.list(null, 100).jobs.length, 26);
    assert.equal(logger.warnings.length, 1);
    assert.match(logger.warnings[0]!, OFF_HOST_WARNING);
  });

  it("warns once without a session", async () => {
    await start();
    session.stop();
    const sync = newSync();
    sync.trigger();
    await sync.idle();
    assert.equal(logger.warnings.filter((message) => message.startsWith("history sync failed")).length, 1);
    assert.equal(store.list(null, 100).jobs.length, 0);
  });

  it("asks for at most 26 ids per Cmd 321", async () => {
    await start();
    const extra = Array.from({ length: 4 }, (_, i) => ({
      ...entries[0],
      TaskId: `synthetic-${i + 1}`,
      TaskName: `/local/test-print-${80 + i}.gcode`,
    }));
    entries.push(...extra);
    const sync = newSync();
    sync.trigger();
    await sync.idle();
    assert.deepEqual(detailRequests(printer).map((ids) => ids.length), [26, 4]);
    assert.equal(store.list(null, 100).jobs.length, 30);
  });

  it("sends no command other than 0, 1, 320, and 321", async () => {
    await start();
    const sync = newSync();
    sync.trigger();
    await sync.idle();
    sync.trigger();
    await sync.idle();
    assert.deepEqual(
      [...new Set(printer.receivedCommands)].filter((cmd) => ![0, 1, 320, 321].includes(cmd)),
      [],
    );
    assert.ok(printer.receivedCommands.includes(320));
  });

  it("stores and counts nothing once closed while a Cmd 321 is in flight", async () => {
    await start();
    const running = entries[0]!;
    // Archived earlier with the newest job running: this sync asks for it again.
    store.upsert(
      entries
        .map((entry) => (entry === running ? { ...entry, TaskStatus: 4 } : entry))
        .map(jobFromDetail)
        .filter((job) => job !== null),
    );
    let sync: HistorySync | undefined;
    const closing: HistorySession = {
      async send(cmd, data) {
        const response = await session.send(cmd, data);
        if (cmd === 321) sync!.close();
        return response;
      },
    };
    sync = new HistorySync({ session: closing, store, logger, printerHost: "127.0.0.1" });
    let changes = 0;
    sync.on("change", () => changes++);
    sync.trigger();
    await sync.idle();
    assert.deepEqual(detailRequests(printer), [[running.TaskId]]);
    assert.equal(store.job(running.TaskId as string)?.outcome, "running");
    // The fixture thumbnails are off the printer's host: a pass over them would count 26 failures.
    assert.equal(store.jobsNeedingThumbnail(1).length, 26);
    assert.equal(changes, 0);
    assert.deepEqual(logger.warnings, []);
  });

  describe("thumbnails", () => {
    let thumbnails: FakeThumbnails;

    beforeEach(async () => {
      thumbnails = await FakeThumbnails.start();
    });

    afterEach(async () => {
      await thumbnails.close();
    });

    /** Starts with the first `count` fixture jobs, their thumbnails on the fake thumbnail server. */
    async function startWithThumbnails(count: number): Promise<void> {
      await start();
      entries.splice(count);
      for (const entry of entries) entry.Thumbnail = thumbnails.urlFor(entry.TaskId as string);
    }

    function thumbnailSync(): HistorySync {
      return new HistorySync({ session, store, logger, printerHost: "127.0.0.1", thumbnailMaxBytes: 1024 });
    }

    it("fetches a thumbnail once across two syncs and stores its bytes", async () => {
      await startWithThumbnails(2);
      const sync = thumbnailSync();
      let changes = 0;
      sync.on("change", () => changes++);
      sync.trigger();
      await sync.idle();
      sync.trigger();
      await sync.idle();
      const id = entries[0]!.TaskId as string;
      assert.equal(thumbnails.requestsFor.get(id), 1);
      assert.equal(thumbnails.requests, 2);
      assert.deepEqual(store.thumbnail(id), { contentType: "image/png", bytes: new Uint8Array(fakePng(id)) });
      assert.equal(store.job(id)?.thumbnail, `/api/history/thumbnail?id=${id}`);
      assert.equal(changes, 1);
      assert.deepEqual(logger.warnings, []);
    });

    it("makes no request for a thumbnail on another host", async () => {
      await startWithThumbnails(1);
      const id = entries[0]!.TaskId as string;
      entries[0]!.Thumbnail = thumbnails.urlFor(id).replace("127.0.0.1", "localhost");
      const sync = thumbnailSync();
      sync.trigger();
      await sync.idle();
      assert.equal(thumbnails.requests, 0);
      assert.equal(store.thumbnail(id), null);
      assert.equal(store.job(id)?.thumbnail, null);
      assert.deepEqual(logger.warnings, [
        `1 history thumbnail(s) not fetched: the URL is not http:// on the printer's host 127.0.0.1 ` +
          `(first: ${entries[0]!.Thumbnail as string})`,
      ]);
    });

    it("escapes control characters of a printer-supplied task id and URL in its warnings", async () => {
      await startWithThumbnails(2);
      const [failing, offHost] = entries as [Record<string, unknown>, Record<string, unknown>];
      failing.TaskId = "job-1\nforged: line";
      failing.Thumbnail = thumbnails.urlFor("job-1");
      offHost.Thumbnail = "http://192.0.2.10/a.png\r\nforged\u2028line";
      thumbnails.answer = () => undefined;
      const sync = thumbnailSync();
      sync.trigger();
      await sync.idle();
      assert.deepEqual(logger.warnings, [
        "thumbnail of history job job-1\\u000aforged: line not stored: answered HTTP 404",
        "1 history thumbnail(s) not fetched: the URL is not http:// on the printer's host 127.0.0.1 " +
          "(first: http://192.0.2.10/a.png\\u000d\\u000aforged\\u2028line)",
      ]);
      for (const warning of logger.warnings) assert.doesNotMatch(warning, /[\r\n\u2028]/);
    });

    for (const [name, answer] of [
      ["an answer over the limit", { body: Buffer.alloc(2048) }],
      ["a chunked answer over the limit", { body: Buffer.alloc(2048), chunked: true }],
      ["a text/html answer", { body: Buffer.from("<html></html>"), contentType: "text/html" }],
      ["a 404 answer", undefined],
    ] as const) {
      it(`stores nothing for ${name} and counts a failure, giving up after 3`, async () => {
        await startWithThumbnails(1);
        const id = entries[0]!.TaskId as string;
        thumbnails.answer = () => answer;
        const sync = thumbnailSync();
        for (let i = 0; i < 4; i++) {
          sync.trigger();
          await sync.idle();
        }
        assert.equal(thumbnails.requestsFor.get(id), 3);
        assert.equal(store.thumbnail(id), null);
        assert.equal(logger.warnings.length, 3);
        assert.match(logger.warnings[0]!, new RegExp(`thumbnail of history job ${id} not stored`));
      });
    }

    for (const [sent, stored] of [
      ["image/jpeg", "image/jpeg"],
      ["Image/PNG; charset=binary", "image/png"],
    ] as const) {
      it(`stores a thumbnail answered as ${sent} with type ${stored}`, async () => {
        await startWithThumbnails(1);
        const id = entries[0]!.TaskId as string;
        thumbnails.answer = (taskId) => ({ contentType: sent, body: fakePng(taskId) });
        const sync = thumbnailSync();
        sync.trigger();
        await sync.idle();
        assert.deepEqual(store.thumbnail(id), { contentType: stored, bytes: new Uint8Array(fakePng(id)) });
        assert.deepEqual(logger.warnings, []);
      });
    }

    it("never requests an https URL, even on the printer's host", async () => {
      await startWithThumbnails(1);
      const id = entries[0]!.TaskId as string;
      entries[0]!.Thumbnail = thumbnails.urlFor(id).replace("http:", "https:");
      const requested: string[] = [];
      const sync = new HistorySync({
        session,
        store,
        logger,
        printerHost: "127.0.0.1",
        fetch: (input, init) => {
          requested.push(String(input));
          return fetch(input, init);
        },
      });
      sync.trigger();
      await sync.idle();
      assert.deepEqual(requested, []);
      assert.equal(store.thumbnail(id), null);
    });

    it("does not follow a redirect, even to the printer's host", async () => {
      await startWithThumbnails(1);
      const id = entries[0]!.TaskId as string;
      const target = await FakeThumbnails.start();
      try {
        thumbnails.answer = () => ({ status: 302, body: new Uint8Array(), headers: { Location: target.urlFor(id) } });
        const sync = thumbnailSync();
        sync.trigger();
        await sync.idle();
        assert.equal(thumbnails.requestsFor.get(id), 1);
        assert.equal(target.requests, 0);
        assert.equal(store.thumbnail(id), null);
        assert.equal(logger.warnings.length, 1);
        assert.match(logger.warnings[0]!, new RegExp(`thumbnail of history job ${id} not stored`));
      } finally {
        await target.close();
      }
    });

    it("gives up on a thumbnail request that gets no answer within the time limit", { timeout: 5_000 }, async () => {
      await startWithThumbnails(2);
      const [hanging, answered] = entries.map((entry) => entry.TaskId as string) as [string, string];
      thumbnails.answer = (taskId) => (taskId === hanging ? { body: new Uint8Array(), hang: true } : { body: fakePng(taskId) });
      const sync = new HistorySync({ session, store, logger, printerHost: "127.0.0.1", thumbnailTimeoutMs: 100 });
      sync.trigger();
      await sync.idle();
      assert.equal(thumbnails.requestsFor.get(hanging), 1);
      assert.equal(store.thumbnail(hanging), null);
      assert.deepEqual(store.thumbnail(answered), { contentType: "image/png", bytes: new Uint8Array(fakePng(answered)) });
      assert.equal(logger.warnings.length, 1);
      assert.match(logger.warnings[0]!, new RegExp(`thumbnail of history job ${hanging} not stored`));
    });
    it("aborts a thumbnail download on close and stores or counts nothing", { timeout: 5_000 }, async () => {
      await startWithThumbnails(2);
      thumbnails.answer = () => ({ body: new Uint8Array(), hang: true });
      // The default 10 s time limit outlasts the test: only the close can end the request.
      const sync = new HistorySync({ session, store, logger, printerHost: "127.0.0.1" });
      sync.trigger();
      while (thumbnails.requests === 0) await new Promise((resolve) => setTimeout(resolve, 10));
      sync.close();
      await sync.idle();
      assert.equal(thumbnails.requests, 1);
      assert.equal(store.jobsNeedingThumbnail(1).length, 2, "no failure counted");
      for (const entry of entries) assert.equal(store.thumbnail(entry.TaskId as string), null);
      assert.deepEqual(logger.warnings, []);
    });

    it("does not store a thumbnail whose download ends after close", async () => {
      await startWithThumbnails(2);
      let sync: HistorySync | undefined;
      let fetches = 0;
      sync = new HistorySync({
        session,
        store,
        logger,
        printerHost: "127.0.0.1",
        // An answer the close cannot abort: its body is already here.
        fetch: async (input) => {
          fetches++;
          sync!.close();
          return new Response(new Uint8Array(fakePng(String(input))), { headers: { "content-type": "image/png" } });
        },
      });
      let changes = 0;
      sync.on("change", () => changes++);
      sync.trigger();
      await sync.idle();
      assert.equal(fetches, 1);
      for (const entry of entries) assert.equal(store.thumbnail(entry.TaskId as string), null);
      assert.equal(store.jobsNeedingThumbnail(1).length, 2);
      assert.equal(changes, 0);
      assert.deepEqual(logger.warnings, []);
    });
  });

  describe("follow-up sync", () => {
    afterEach(() => {
      mock.timers.reset();
    });

    /** Starts with the newest fixture job still running, then mocks setTimeout. */
    async function startRunning(): Promise<Record<string, unknown>> {
      await start();
      const running = entries[0]!;
      running.TaskStatus = 4;
      mock.timers.enable({ apis: ["setTimeout"] });
      return running;
    }

    /** Moves the mocked clock past the follow-up delay. */
    function tick(): void {
      mock.timers.tick(10_000);
    }

    it("re-requests a job left running after 10 s, at most 3 times in a row", async () => {
      const running = await startRunning();
      const sync = newSync();
      sync.trigger();
      await sync.idle();
      assert.equal(detailRequests(printer).length, 1);
      mock.timers.tick(9_999);
      await sync.idle();
      assert.equal(detailRequests(printer).length, 1);
      for (let i = 0; i < 3; i++) {
        tick();
        await sync.idle();
        assert.deepEqual(detailRequests(printer).at(-1), [running.TaskId]);
      }
      assert.equal(detailRequests(printer).length, 4);
      tick();
      await sync.idle();
      assert.equal(detailRequests(printer).length, 4);
      assert.equal(printer.receivedCommands.filter((cmd) => cmd === 320).length, 4);
    });

    it("starts a new run of follow-ups on a trigger after the last one", async () => {
      const running = await startRunning();
      const sync = newSync();
      sync.trigger();
      await sync.idle();
      for (let i = 0; i < 3; i++) {
        tick();
        await sync.idle();
      }
      tick();
      await sync.idle();
      assert.equal(detailRequests(printer).length, 4, "the follow-ups ran out");
      sync.trigger();
      await sync.idle();
      for (let i = 0; i < 3; i++) {
        tick();
        await sync.idle();
      }
      assert.equal(detailRequests(printer).length, 8);
      assert.deepEqual(detailRequests(printer).at(-1), [running.TaskId]);
    });

    it("settles once the printer answers TaskStatus 1", async () => {
      const running = await startRunning();
      const sync = newSync();
      sync.trigger();
      await sync.idle();
      running.TaskStatus = 1;
      running.EndTime = 1794605500;
      tick();
      await sync.idle();
      assert.deepEqual(detailRequests(printer).at(-1), [running.TaskId]);
      assert.equal(store.job(running.TaskId as string)?.outcome, "completed");
      tick();
      await sync.idle();
      assert.equal(detailRequests(printer).length, 2);
    });

    it("schedules no follow-up while a print is active", async () => {
      await startRunning();
      const sync = new HistorySync({ session, store, logger, printerHost: "127.0.0.1", printActive: () => true });
      sync.trigger();
      await sync.idle();
      tick();
      await sync.idle();
      assert.equal(detailRequests(printer).length, 1);
    });

    it("cancels a pending follow-up on close", async () => {
      await startRunning();
      const sync = newSync();
      sync.trigger();
      await sync.idle();
      sync.close();
      tick();
      await sync.idle();
      assert.equal(printer.receivedCommands.filter((cmd) => cmd === 320).length, 1);
    });
  });
});
