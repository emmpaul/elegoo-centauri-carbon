import { strict as assert } from "node:assert";
import { once } from "node:events";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, it } from "node:test";
import { defaultConfig, EVENT_TYPES, type EventType } from "../src/config.ts";
import type { PrintEvent } from "../src/event-detector.ts";
import { DEFAULT_RETRY_DELAYS_MS, formatDuration, formatEvent, NtfyNotifier, notifierFromConfig } from "../src/notifier.ts";
import type { Logger, StatusMessage } from "../src/sdcp-client.ts";
import { type Service, startService } from "../src/service.ts";
import { FakeNtfy } from "./support/fake-ntfy.ts";
import { FakePrinter, loadFixture } from "./support/fake-printer.ts";

const finished: PrintEvent = {
  type: "finished",
  at: 0,
  printerName: "Centauri Carbon",
  jobId: "c735768d-8d67-4ae2-8d07-05c0c05c4aa2",
  fileName: "test-print-2.gcode",
  progress: 100,
  durationSeconds: 398,
  errorCode: null,
};

const allOn = () => Object.fromEntries(EVENT_TYPES.map((e) => [e, true])) as Record<EventType, boolean>;

function recordingLogger(): Logger & { infos: string[]; warnings: string[]; errors: string[] } {
  const infos: string[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  return { infos, warnings, errors, info: (m) => infos.push(m), warn: (m) => warnings.push(m), error: (m) => errors.push(m) };
}

const paused: PrintEvent = { ...finished, type: "paused", fileName: "test-print-1.gcode", progress: 42, durationSeconds: null };
/** A small JPEG-like body: SOI, arbitrary bytes (not valid UTF-8), EOI. */
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x80, 0xc3, 0x28, 0x0d, 0x0a, 0xff, 0xd9]);

/** Decodes one RFC 2047 encoded word (=?UTF-8?B?…?=). */
function decodeWord(value: string): string {
  const match = /^=\?UTF-8\?B\?([A-Za-z0-9+/=]*)\?=$/.exec(value);
  assert.ok(match, `an encoded word: ${value}`);
  return Buffer.from(match[1] as string, "base64").toString("utf8");
}

/** A URL on 127.0.0.1 where nothing listens: a port taken and released again. */
async function unreachableUrl(): Promise<string> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

describe("push messages", () => {
  it("carry the file name and duration for finished, and progress and the raw code for failed", () => {
    assert.deepEqual(formatEvent(finished), {
      title: "Print finished",
      message: "test-print-2.gcode finished in 6m 38s.",
      priority: 3,
      tags: ["white_check_mark"],
    });
    assert.deepEqual(formatEvent({ ...finished, type: "failed", progress: 92, errorCode: 45 }), {
      title: "Print failed",
      message: "test-print-2.gcode failed at 92% (error code 45).",
      priority: 4,
      tags: ["x"],
    });
    for (const type of EVENT_TYPES) assert.ok(formatEvent({ ...finished, type }).message.length > 0, type);
  });

  it("formats durations", () => {
    assert.equal(formatDuration(45), "45s");
    assert.equal(formatDuration(398), "6m 38s");
    assert.equal(formatDuration(3725), "1h 02m");
  });

  it("uses increasing back-off delays for 3 retries by default", () => {
    assert.equal(DEFAULT_RETRY_DELAYS_MS.length, 3);
    assert.ok(DEFAULT_RETRY_DELAYS_MS.every((d, i) => i === 0 || d > (DEFAULT_RETRY_DELAYS_MS[i - 1] as number)));
  });
});

describe("NtfyNotifier against a fake ntfy endpoint", () => {
  let ntfy: FakeNtfy;
  beforeEach(async () => {
    ntfy = await FakeNtfy.start();
  });
  afterEach(async () => {
    await ntfy.close();
  });

  it("records a binary PUT upload with its raw bytes and headers", async () => {
    const bytes = Buffer.from([0xff, 0xd8, 0x00, 0x80, 0xfe, 0x0a, 0x0d, 0xc3, 0x28, 0xff, 0xd9]);
    const response = await fetch(`${ntfy.url}/printer-abc123`, {
      method: "PUT",
      headers: { Filename: "photo-paused.jpg", "Content-Type": "image/jpeg" },
      body: bytes,
    });
    assert.equal(response.status, 200);
    assert.equal(ntfy.requests.length, 1);
    const [request] = ntfy.requests;
    assert.equal(request?.method, "PUT");
    assert.equal(request?.path, "/printer-abc123");
    assert.equal(request?.headers.filename, "photo-paused.jpg");
    assert.ok(Buffer.isBuffer(request?.raw));
    assert.deepEqual(request?.raw, bytes);
  });

  it("publishes an enabled event to the configured topic", async () => {
    const notifier = new NtfyNotifier({ url: `${ntfy.url}/`, topic: "printer-abc123", events: allOn(), logger: recordingLogger() });
    await notifier.notify(finished);
    assert.equal(ntfy.requests.length, 1);
    const [request] = ntfy.requests;
    assert.equal(request?.method, "POST");
    assert.equal(request?.path, "/");
    assert.deepEqual(request?.json, {
      topic: "printer-abc123",
      title: "Print finished",
      message: "test-print-2.gcode finished in 6m 38s.",
      priority: 3,
      tags: ["white_check_mark"],
    });
  });

  it("sends nothing for a disabled event", async () => {
    const events = { ...allOn(), started: false };
    const notifier = new NtfyNotifier({ url: ntfy.url, topic: "t", events, logger: recordingLogger() });
    await notifier.notify({ ...finished, type: "started" });
    assert.equal(ntfy.requests.length, 0);
    await notifier.notify(finished);
    assert.equal(ntfy.requests.length, 1);
  });

  it("retries an error answer with back-off and stops once delivered", async () => {
    ntfy.statuses.push(500, 503);
    const logger = recordingLogger();
    const notifier = new NtfyNotifier({ url: ntfy.url, topic: "t", events: allOn(), retryDelaysMs: [30, 60, 120], logger });
    const started = performance.now();
    await notifier.notify(finished);
    const took = performance.now() - started;
    assert.equal(ntfy.requests.length, 3);
    assert.ok(took >= 90, `waited 30 + 60 ms, took ${took}`);
    assert.equal(logger.warnings.length, 2);
    assert.match(logger.warnings[0] as string, /HTTP 500.*retry 1 of 3 in 30 ms/);
    assert.deepEqual(logger.errors, []);
  });

  it("gives up after 3 retries on error answers and logs the failure", async () => {
    ntfy.statuses.push(500, 500, 500, 500, 500);
    const logger = recordingLogger();
    const notifier = new NtfyNotifier({ url: ntfy.url, topic: "t", events: allOn(), retryDelaysMs: [1, 1, 1], logger });
    await notifier.notify(finished);
    assert.equal(ntfy.requests.length, 4, "the first attempt plus 3 retries");
    assert.equal(logger.errors.length, 1);
    assert.match(logger.errors[0] as string, /gave up on finished after 3 retries: HTTP 500/);
  });

  it("uploads a paused event with its Photo as a PUT with the message in headers", async () => {
    const logger = recordingLogger();
    const notifier = new NtfyNotifier({ url: ntfy.url, topic: "t", events: allOn(), logger });
    await notifier.notify(paused, async () => ({ jpeg }));
    assert.equal(ntfy.requests.length, 1);
    const [request] = ntfy.requests;
    assert.equal(request?.method, "PUT");
    assert.equal(request?.path, "/t");
    assert.deepEqual(request?.raw, jpeg);
    assert.equal(request?.headers.title, "Print paused");
    assert.equal(request?.headers.message, "test-print-1.gcode paused at 42%.");
    assert.equal(request?.headers.priority, "3");
    assert.equal(request?.headers.tags, "pause_button");
    assert.equal(request?.headers.filename, "photo-paused.jpg");
    assert.equal(request?.headers["content-type"], "image/jpeg");
    assert.deepEqual(logger.warnings, []);
    assert.deepEqual(logger.errors, []);
  });

  it("encodes a non-ASCII file name in the message header as an RFC 2047 encoded word", async () => {
    const notifier = new NtfyNotifier({ url: ntfy.url, topic: "t", events: allOn(), logger: recordingLogger() });
    await notifier.notify({ ...paused, fileName: "test-print-1-ü.gcode" }, async () => ({ jpeg }));
    const [request] = ntfy.requests;
    assert.equal(request?.method, "PUT");
    assert.equal(decodeWord(request?.headers.message as string), "test-print-1-ü.gcode paused at 42%.");
    assert.equal(request?.headers.title, "Print paused", "ASCII values stay plain");
  });

  it("publishes JSON as before without a photo provider", async () => {
    const logger = recordingLogger();
    const notifier = new NtfyNotifier({ url: ntfy.url, topic: "t", events: allOn(), logger });
    await notifier.notify(paused);
    assert.equal(ntfy.requests.length, 1);
    assert.equal(ntfy.requests[0]?.method, "POST");
    assert.equal((ntfy.requests[0]?.json as { title: string }).title, "Print paused");
  });

  it("publishes JSON and logs the reason when the provider has no Photo", async () => {
    const logger = recordingLogger();
    const notifier = new NtfyNotifier({ url: ntfy.url, topic: "t", events: allOn(), logger });
    await notifier.notify(paused, async () => ({ jpeg: null, reason: "photo timed out" }));
    assert.equal(ntfy.requests.length, 1);
    assert.equal(ntfy.requests[0]?.method, "POST");
    assert.equal((ntfy.requests[0]?.json as { message: string }).message, "test-print-1.gcode paused at 42%.");
    assert.deepEqual(logger.infos, ["ntfy: paused sent without a photo: photo timed out"]);
  });

  it("never calls the photo provider for a disabled event", async () => {
    const notifier = new NtfyNotifier({ url: ntfy.url, topic: "t", events: { ...allOn(), paused: false }, logger: recordingLogger() });
    let calls = 0;
    await notifier.notify(paused, async () => {
      calls++;
      return { jpeg };
    });
    assert.equal(calls, 0);
    assert.equal(ntfy.requests.length, 0);
  });

  for (const status of [400, 413]) {
    it(`falls back to one text-only publish when ntfy rejects the upload with ${status}`, async () => {
      ntfy.statuses.push(status);
      const logger = recordingLogger();
      const notifier = new NtfyNotifier({ url: ntfy.url, topic: "t", events: allOn(), retryDelaysMs: [10, 10, 10], logger });
      const delivery = await notifier.deliver(formatEvent(paused), "paused", { jpeg });
      assert.deepEqual(
        ntfy.requests.map((r) => r.method),
        ["PUT", "POST"],
      );
      assert.equal((ntfy.requests[1]?.json as { title: string }).title, "Print paused");
      assert.deepEqual(logger.warnings, [`ntfy: photo upload for paused rejected (HTTP ${status}); sending text only`]);
      assert.deepEqual(logger.errors, []);
      assert.deepEqual(delivery, { delivered: true, photo: false, fallback: `HTTP ${status}` });
    });
  }

  it("retries an upload answered with 503 and sends no text fallback", async () => {
    ntfy.statuses.push(503, 200);
    const logger = recordingLogger();
    const notifier = new NtfyNotifier({ url: ntfy.url, topic: "t", events: allOn(), retryDelaysMs: [10, 10, 10], logger });
    const delivery = await notifier.deliver(formatEvent(paused), "paused", { jpeg });
    assert.deepEqual(
      ntfy.requests.map((r) => r.method),
      ["PUT", "PUT"],
    );
    assert.deepEqual(ntfy.requests[1]?.raw, jpeg);
    assert.equal(logger.warnings.length, 1);
    assert.match(logger.warnings[0] as string, /HTTP 503.*retry 1 of 3/);
    assert.deepEqual(delivery, { delivered: true, photo: true, fallback: null });
  });

  it("gives up on an upload after 3 retries on server errors, without a text fallback", async () => {
    ntfy.statuses.push(503, 503, 503, 503);
    const logger = recordingLogger();
    const notifier = new NtfyNotifier({ url: ntfy.url, topic: "t", events: allOn(), retryDelaysMs: [10, 10, 10], logger });
    const delivery = await notifier.deliver(formatEvent(paused), "paused", { jpeg });
    assert.deepEqual(
      ntfy.requests.map((r) => r.method),
      ["PUT", "PUT", "PUT", "PUT"],
    );
    assert.equal(logger.errors.length, 1);
    assert.match(logger.errors[0] as string, /gave up on paused after 3 retries: HTTP 503/);
    assert.equal(delivery.delivered, false);
    assert.equal(delivery.photo, false);
  });

  it("builds no notifier without a topic", () => {
    assert.equal(notifierFromConfig(defaultConfig()), null);
    const config = defaultConfig();
    config.ntfy = { ...config.ntfy, url: ntfy.url, topic: "t" };
    assert.ok(notifierFromConfig(config) instanceof NtfyNotifier);
  });
});

describe("NtfyNotifier with the endpoint unreachable", () => {
  it("retries 3 times with growing waits, logs the failure, and resolves", async () => {
    const logger = recordingLogger();
    const notifier = new NtfyNotifier({ url: await unreachableUrl(), topic: "t", events: allOn(), retryDelaysMs: [20, 40, 80], logger });
    const started = performance.now();
    await notifier.notify(finished);
    assert.ok(performance.now() - started >= 140, "waited 20 + 40 + 80 ms");
    assert.deepEqual(
      logger.warnings.map((w) => w.replace(/\(.*\)/, "(…)")),
      [
        "ntfy: finished not delivered (…); retry 1 of 3 in 20 ms",
        "ntfy: finished not delivered (…); retry 2 of 3 in 40 ms",
        "ntfy: finished not delivered (…); retry 3 of 3 in 80 ms",
      ],
    );
    assert.match(logger.warnings[0] as string, /ECONNREFUSED/);
    assert.equal(logger.errors.length, 1);
    assert.match(logger.errors[0] as string, /gave up on finished after 3 retries: .*ECONNREFUSED/);
  });
});

describe("notifications in the service, against the fake printer", () => {
  let printer: FakePrinter;
  let service: Service | undefined;

  beforeEach(async () => {
    printer = await FakePrinter.start({
      replies: {
        321: (data) => ({ Ack: 0, HistoryDetailList: (data.Id as string[]).map((id) => ({ TaskId: id, ErrorStatusReason: 0 })) }),
      },
    });
  });
  afterEach(async () => {
    await service?.close();
    service = undefined;
    await printer.close();
  });

  function statusFrame(seq: number): StatusMessage {
    return structuredClone(loadFixture("print-complete.json").frames.find((f) => f.seq === seq)?.payload) as StatusMessage;
  }

  async function until(done: () => boolean, push?: StatusMessage): Promise<void> {
    for (let i = 0; i < 300 && !done(); i++) {
      if (push) printer.push(push);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(done(), "condition reached");
  }

  async function finishAJob(notifier: NtfyNotifier, logger: Logger): Promise<Service> {
    service = await startService({
      printerUrl: printer.url,
      cameraUrl: "http://127.0.0.1:9/video",
      listen: { host: "127.0.0.1", port: 0 },
      token: null,
      logger,
      notifier,
    });
    const s = service;
    await printer.waitForClient();
    await until(() => s.store.snapshot.taskId !== null, statusFrame(23));
    printer.push(statusFrame(24));
    return s;
  }

  it("publishes print finished once, with the file name and duration", async () => {
    const ntfy = await FakeNtfy.start();
    try {
      const logger = recordingLogger();
      const s = await finishAJob(new NtfyNotifier({ url: ntfy.url, topic: "t", events: allOn(), logger }), logger);
      await until(() => ntfy.requests.length > 0);
      for (const seq of [29, 30, 31]) printer.push(statusFrame(seq));
      await until(() => s.store.snapshot.printState.name === "completed");
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(ntfy.requests.length, 1);
      assert.match((ntfy.requests[0]?.json as { message: string }).message, /^test-print-2\.gcode finished in 6m 38s\.$/);
    } finally {
      await ntfy.close();
    }
  });

  it("keeps monitoring the printer while ntfy is unreachable", async () => {
    const logger = recordingLogger();
    const notifier = new NtfyNotifier({ url: await unreachableUrl(), topic: "t", events: allOn(), retryDelaysMs: [100, 100, 100], logger });
    const s = await finishAJob(notifier, logger);
    await until(() => logger.warnings.some((w) => w.startsWith("ntfy: finished not delivered")));
    // While retries are pending, status keeps flowing and the session stays up.
    const later = statusFrame(29);
    (later.Status as Record<string, unknown>).TempOfNozzle = 123.4;
    await until(() => s.store.snapshot.temperatures.nozzle.current === 123.4, later);
    assert.equal(s.store.snapshot.connection, "online");
    await until(() => logger.errors.some((e) => e.startsWith("ntfy: gave up on finished after 3 retries")));
    assert.equal(s.session.state, "online");
    assert.equal(printer.clientCount, 1, "the session was never dropped");
  });
});
