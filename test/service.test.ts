import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { get, type IncomingMessage } from "node:http";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { CameraProxy } from "../src/camera-proxy.ts";
import { defaultConfig, EVENT_TYPES, type EventType } from "../src/config.ts";
import { isJobActive, type PrintEvent } from "../src/event-detector.ts";
import { FOLLOW_UP_DELAY_MS } from "../src/history-sync.ts";
import { NtfyNotifier } from "../src/notifier.ts";
import type { Logger, StatusMessage } from "../src/sdcp-client.ts";
import { type Service, type ServiceOptions, startService } from "../src/service.ts";
import { FakeMjpegSource, fakeJpeg } from "./support/fake-mjpeg.ts";
import { FakeNtfy, type NtfyRequest } from "./support/fake-ntfy.ts";
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

  it("closes the history archive when the port is taken, and contacts no printer", async () => {
    const taken = createServer();
    await new Promise<void>((resolve) => taken.listen(0, "127.0.0.1", resolve));
    const { port } = taken.address() as { port: number };
    const dir = mkdtempSync(join(tmpdir(), "ecc-service-"));
    const historyPath = join(dir, "history.sqlite");
    try {
      await assert.rejects(
        startService({
          printerUrl: printer.url,
          cameraUrl: "http://127.0.0.1:9/video",
          listen: { host: "127.0.0.1", port },
          token: null,
          logger: silentLogger(),
          historyPath,
        }),
        /EADDRINUSE/,
      );
      assert.ok(existsSync(historyPath), "the archive was opened");
      // SQLite removes the WAL file when the last connection closes: one left means an open handle.
      assert.equal(existsSync(`${historyPath}-wal`), false, "the archive was closed");
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(printer.clientCount, 0);
    } finally {
      await new Promise<void>((resolve) => taken.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("closes the detector's offline timer and the camera proxy when the port is taken", async () => {
    const taken = createServer();
    await new Promise<void>((resolve) => taken.listen(0, "127.0.0.1", resolve));
    const { port } = taken.address() as { port: number };
    const cameraClose = mock.method(CameraProxy.prototype, "close");
    const logged: string[] = [];
    const logger: Logger = { info: (line) => logged.push(line), warn() {}, error() {} };
    try {
      await assert.rejects(
        startService({
          printerUrl: printer.url,
          cameraUrl: "http://127.0.0.1:9/video",
          listen: { host: "127.0.0.1", port },
          token: null,
          logger,
          // The detector starts its offline timer at once: the printer is not connected yet.
          offlineAfterMs: 20,
        }),
        /EADDRINUSE/,
      );
      assert.equal(cameraClose.mock.callCount(), 1);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.deepEqual(
        logged.filter((line) => line.startsWith("event:")),
        [],
        "the offline timer was cleared",
      );
    } finally {
      cameraClose.mock.restore();
      await new Promise<void>((resolve) => taken.close(() => resolve()));
    }
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

  for (const type of ["failed", "stopped"] as const) {
    it(`syncs once on a ${type} job end, and not on a pause`, async () => {
      await printer.waitForClient();
      printer.replay(loadFixture("connect-idle.json"));
      await until(() => service!.history.list(null, 100).jobs.length === 26, "26 archived jobs");
      const syncs = () => printer.receivedCommands.filter((cmd) => cmd === 320).length;
      await new Promise((resolve) => setTimeout(resolve, 50));
      const before = syncs();

      const event = (eventType: PrintEvent["type"]): PrintEvent => ({
        type: eventType,
        at: Date.now(),
        printerName: null,
        jobId: endedId,
        fileName: null,
        progress: null,
        durationSeconds: null,
        errorCode: null,
        remainingSeconds: null,
      });
      // A pause that triggered too would run a second sync for the end that follows it.
      service!.detector.emit("event", event("paused"));
      service!.detector.emit("event", event(type));
      await until(() => syncs() > before, `a sync after the ${type} event`);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(syncs(), before + 1);
    });
  }

  /** Lets `ms` of real time pass without `setTimeout`, which the mock timers replace. */
  async function realWait(ms: number): Promise<void> {
    const end = performance.now() + ms;
    while (performance.now() < end) await new Promise((resolve) => setImmediate(resolve));
  }

  for (const printing of [true, false]) {
    it(`${printing ? "sends no" : "sends a"} follow-up sync for a job listed as running while the status ${printing ? "shows a print" : "is idle"}`, async () => {
      // The printer lists the newest job as still running.
      Object.assign(entries[0]!, { TaskStatus: 4 });
      await printer.waitForClient();
      if (printing) printer.replay(loadFixture("print-complete.json"), (frame) => frame.seq <= 9);
      // connect-idle.json is idle up to seq 32; a print starts after it.
      else printer.replay(loadFixture("connect-idle.json"), (frame) => frame.seq <= 32);
      const snapshot = () => service!.store.snapshot;
      await until(() => snapshot().machineState.code !== null && isJobActive(snapshot()) === printing, "the status");
      await until(() => service!.history.job(endedId)?.outcome === "running", "the running job archived");
      const syncs = () => printer.receivedCommands.filter((cmd) => cmd === 320).length;

      mock.timers.enable({ apis: ["setTimeout"] });
      try {
        const before = syncs();
        service!.detector.emit("event", {
          type: "finished",
          at: Date.now(),
          printerName: null,
          jobId: endedId,
          fileName: null,
          progress: null,
          durationSeconds: null,
          errorCode: null,
          remainingSeconds: null,
        });
        await realWait(300);
        assert.equal(syncs(), before + 1, "the triggered sync ran");
        mock.timers.tick(FOLLOW_UP_DELAY_MS);
        await realWait(300);
        assert.equal(syncs(), printing ? before + 1 : before + 2);
      } finally {
        mock.timers.reset();
      }
    });
  }
});

describe("startService close", () => {
  it("ends a sync waiting on Cmd 321 without a warning", async () => {
    const frame = loadFixture("print-complete.json").frames.find((f) => f.seq === 28);
    const entries = (frame?.payload as { Data: { Data: { HistoryDetailList: Record<string, unknown>[] } } }).Data.Data.HistoryDetailList;
    const printer = await FakePrinter.start({ history: { entries }, replies: { 321: "silent" } });
    const warnings: string[] = [];
    const service = await startService({
      printerUrl: printer.url,
      cameraUrl: "http://127.0.0.1:9/video",
      listen: { host: "127.0.0.1", port: 0 },
      token: null,
      logger: { info() {}, warn: (line) => warnings.push(line), error() {} },
    });
    try {
      await printer.waitForClient();
      printer.replay(loadFixture("connect-idle.json"), (frame) => frame.seq <= 32);
      const deadline = Date.now() + 3000;
      while (!printer.receivedCommands.includes(321)) {
        if (Date.now() > deadline) assert.fail("timed out waiting for Cmd 321");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      await service.close();
      await printer.close();
    }
    // A sync still running would log the lost session as a failed sync.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(warnings.filter((line) => line.startsWith("history sync")), []);
  });
});

describe("startService photos", () => {
  let printer: FakePrinter;
  let camera: FakeMjpegSource;
  let ntfy: FakeNtfy;
  let service: Service | undefined;

  beforeEach(async () => {
    printer = await FakePrinter.start();
    camera = await FakeMjpegSource.start();
    ntfy = await FakeNtfy.start();
  });

  afterEach(async () => {
    await service?.close();
    service = undefined;
    await printer.close();
    await camera.close();
    await ntfy.close();
  });

  /** A `print-complete.json` status push: seq 23 prints, seq 24 has finished. */
  function statusFrame(seq: number): StatusMessage {
    return structuredClone(loadFixture("print-complete.json").frames.find((f) => f.seq === seq)?.payload) as StatusMessage;
  }

  /** Resolves once `check` holds, polling every 10 ms (pushing `push` each time) for at most `ms`. */
  async function until(check: () => boolean, what: string, push?: StatusMessage, ms = 3000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!check()) {
      if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
      if (push) printer.push(push);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  async function start(options: Partial<ServiceOptions>): Promise<Service> {
    service = await startService({
      printerUrl: printer.url,
      cameraUrl: camera.url,
      listen: { host: "127.0.0.1", port: 0 },
      token: null,
      logger: silentLogger(),
      notifier: new NtfyNotifier({ url: ntfy.url, topic: "t", events: Object.fromEntries(EVENT_TYPES.map((e) => [e, true])) as Record<EventType, boolean>, retryDelaysMs: [], logger: silentLogger() }),
      ...options,
    });
    return service;
  }

  /** `statusFrame(seq)` with the chamber light (`LightStatus.SecondLight`) set to `light`. */
  function withLight(frame: StatusMessage, light: 0 | 1): StatusMessage {
    const status = frame.Status as { LightStatus: { SecondLight: number } };
    status.LightStatus.SecondLight = light;
    return frame;
  }

  /** Runs a job from printing (seq 23) to finished (seq 24), with the light as `light` (on in the fixture). */
  async function finishAJob(s: Service, light: 0 | 1 = 1): Promise<void> {
    await printer.waitForClient();
    await until(() => s.store.snapshot.taskId !== null, "the printing status", withLight(statusFrame(23), light));
    printer.push(withLight(statusFrame(24), light));
  }

  /** The `SecondLight` values of the Cmd 403 requests the printer received, in order. */
  function lightCommands(): number[] {
    return printer.received.flatMap((frame) => {
      const data = (frame.payload as { Data?: { Cmd?: number; Data?: { LightStatus?: { SecondLight?: number } } } }).Data;
      return data?.Cmd === 403 ? [data.Data?.LightStatus?.SecondLight ?? -1] : [];
    });
  }

  /** Whether `raw` is one whole part of the fake camera (`fakeJpeg(n)`). */
  function isFakeJpegPart(raw: Buffer): boolean {
    const match = /frame-(\d+)/.exec(raw.toString("latin1"));
    return match !== null && raw.equals(fakeJpeg(Number(match[1])));
  }

  function event(type: PrintEvent["type"]): PrintEvent {
    return { type, at: Date.now(), printerName: null, jobId: "j", fileName: "test-print-1.gcode", progress: null, durationSeconds: null, errorCode: null, remainingSeconds: null };
  }

  it("uploads a Photo from the camera with a finished Notification and closes the camera afterwards", async () => {
    const s = await start({ photos: { light: false } });
    await finishAJob(s);
    await until(() => ntfy.requests.length > 0, "the Notification");
    const [request] = ntfy.requests as [NtfyRequest];
    assert.equal(request.method, "PUT");
    assert.equal(request.path, "/t");
    assert.equal(request.headers.filename, "photo-finished.jpg");
    assert.ok(isFakeJpegPart(request.raw), "the body is one whole camera part");
    await camera.waitForNoStreams();
    assert.equal(camera.connections, 1);
    assert.equal(ntfy.requests.length, 1);
  });

  it("publishes JSON and never contacts the camera with photos off", async () => {
    const s = await start({ photos: null });
    await finishAJob(s);
    await until(() => ntfy.requests.length > 0, "the Notification");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(ntfy.requests.length, 1);
    assert.equal(ntfy.requests[0]?.method, "POST");
    assert.equal((ntfy.requests[0]?.json as { title: string }).title, "Print finished");
    assert.equal(camera.connections, 0);
  });

  it("publishes a started Notification as JSON with photos on", async () => {
    const s = await start({ photos: { light: false } });
    await printer.waitForClient();
    s.detector.emit("event", event("started"));
    await until(() => ntfy.requests.length > 0, "the Notification");
    assert.equal(ntfy.requests[0]?.method, "POST");
    assert.equal((ntfy.requests[0]?.json as { title: string }).title, "Print started");
    assert.equal(camera.connections, 0);
  });

  it("uploads a Photo with a first-layer Notification", async () => {
    const s = await start({ photos: { light: false } });
    await printer.waitForClient();
    s.detector.emit("event", event("first-layer"));
    await until(() => ntfy.requests.length > 0, "the Notification");
    const [request] = ntfy.requests as [NtfyRequest];
    assert.equal(request.method, "PUT");
    assert.equal(request.headers.filename, "photo-first-layer.jpg");
    assert.ok(isFakeJpegPart(request.raw), "the body is one whole camera part");
    await camera.waitForNoStreams();
    assert.equal(ntfy.requests.length, 1);
  });

  it("publishes an almost-done Notification as JSON with photos on", async () => {
    const s = await start({ photos: { light: false } });
    await printer.waitForClient();
    s.detector.emit("event", { ...event("almost-done"), remainingSeconds: 590 });
    await until(() => ntfy.requests.length > 0, "the Notification");
    assert.equal(ntfy.requests[0]?.method, "POST");
    assert.equal((ntfy.requests[0]?.json as { title: string }).title, "Almost done");
    assert.equal(camera.connections, 0);
  });

  it("takes the Photo from the stream a dashboard viewer already holds", async () => {
    const s = await start({ photos: { light: false } });
    const viewer = await new Promise<IncomingMessage>((resolve, reject) =>
      get(`http://127.0.0.1:${s.address.port}/camera`, resolve).on("error", reject),
    );
    try {
      assert.equal(viewer.statusCode, 200);
      let received = 0;
      viewer.on("data", (chunk: Buffer) => (received += chunk.length));
      await until(() => received > 0, "the viewer's first bytes");
      await finishAJob(s);
      await until(() => ntfy.requests.length > 0, "the Notification");
      assert.equal(ntfy.requests[0]?.method, "PUT");
      assert.ok(isFakeJpegPart(ntfy.requests[0]!.raw));
      const before = received;
      await until(() => received > before, "the viewer still receiving");
      assert.equal(camera.connections, 1);
    } finally {
      viewer.destroy();
    }
  });

  it("turns the light on for the Photo, waits for the push showing it on, and turns it off again", async () => {
    const s = await start({ photos: { light: true } });
    let putsAtLightOn = -1;
    printer.onFrame((frame) => {
      const data = (frame.payload as { Data?: { Cmd?: number; Data?: { LightStatus?: { SecondLight?: number } } } }).Data;
      if (data?.Cmd !== 403 || data.Data?.LightStatus?.SecondLight !== 1) return;
      // The printer reports the light on a moment after the command, as its status push would.
      setTimeout(() => {
        putsAtLightOn = ntfy.requests.length;
        printer.push(withLight(statusFrame(24), 1));
      }, 100);
    });
    await finishAJob(s, 0);
    await until(() => ntfy.requests.length > 0, "the Notification");
    assert.equal(ntfy.requests[0]?.method, "PUT");
    assert.equal(putsAtLightOn, 0, "the upload came after the status push showing the light on");
    await until(() => lightCommands().length === 2, "the off command");
    assert.deepEqual(lightCommands(), [1, 0]);
  });

  it("takes the Photo and turns the light off again when no push shows the light on", async () => {
    const s = await start({ photos: { light: true } });
    await finishAJob(s, 0);
    const detected = Date.now();
    await until(() => ntfy.requests.length > 0, "the Notification", undefined, 6000);
    assert.ok(Date.now() - detected < 6000);
    assert.equal(ntfy.requests[0]?.method, "PUT");
    assert.ok(isFakeJpegPart(ntfy.requests[0]!.raw));
    await until(() => lightCommands().length === 2, "the off command");
    assert.deepEqual(lightCommands(), [1, 0]);
  });

  it("turns the light off again when the service closes during a Photo-light Photo", async () => {
    const s = await start({ photos: { light: true } });
    await finishAJob(s, 0);
    await until(() => lightCommands().length === 1, "the on command");
    const closing = Date.now();
    await s.close();
    service = undefined;
    assert.ok(Date.now() - closing < 2000, "close stays bounded");
    await until(() => lightCommands().length === 2, "the off command");
    assert.deepEqual(lightCommands(), [1, 0]);
  });

  it("sends the Notification as JSON within 6 s when the camera port is closed", async () => {
    const closed = await FakeMjpegSource.start();
    const closedUrl = closed.url;
    await closed.close();
    const s = await start({ photos: { light: false }, cameraUrl: closedUrl });
    await finishAJob(s);
    const detected = Date.now();
    await until(() => ntfy.requests.length > 0, "the Notification", undefined, 6000);
    assert.ok(Date.now() - detected < 6000);
    assert.equal(ntfy.requests[0]?.method, "POST");
    assert.equal((ntfy.requests[0]?.json as { title: string }).title, "Print finished");
  });
});

describe("startService progress notifications", () => {
  const TASK = "00000000-0000-4000-8000-00000000000a";
  let printer: FakePrinter;
  let ntfy: FakeNtfy;
  let service: Service | undefined;

  beforeEach(async () => {
    printer = await FakePrinter.start();
    ntfy = await FakeNtfy.start();
  });

  afterEach(async () => {
    await service?.close();
    service = undefined;
    await printer.close();
    await ntfy.close();
  });

  /** A printing push of one job on `layer` with `current` of 1500 ticks elapsed. */
  function push(layer: number, current: number, progress: number): StatusMessage {
    const frame = structuredClone(loadFixture("control-pause-resume-light.json").frames.find((f) => f.seq === 11)?.payload) as StatusMessage;
    frame.Status.CurrentStatus = [1];
    frame.Status.PrintInfo = {
      ...(frame.Status.PrintInfo as Record<string, unknown>),
      Status: 13,
      TaskId: TASK,
      Filename: "test-print-1.gcode",
      CurrentLayer: layer,
      TotalLayer: 50,
      CurrentTicks: current,
      TotalTicks: 1500,
      Progress: progress,
    };
    return frame;
  }

  /** Pushes `message` every 10 ms until `check` holds, for at most 3 s. */
  async function pushUntil(message: StatusMessage, check: () => boolean): Promise<void> {
    const deadline = Date.now() + 3000;
    while (!check()) {
      if (Date.now() > deadline) assert.fail("timed out waiting for the status push");
      printer.push(message);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  /** Runs one job across its first layer and the ten-minute mark; returns the titles sent. */
  async function runAJob(events: Record<EventType, boolean>): Promise<string[]> {
    const s = await startService({
      printerUrl: printer.url,
      cameraUrl: "http://127.0.0.1:9/video",
      listen: { host: "127.0.0.1", port: 0 },
      token: null,
      logger: silentLogger(),
      notifier: new NtfyNotifier({ url: ntfy.url, topic: "t", events, retryDelaysMs: [], logger: silentLogger() }),
    });
    service = s;
    await printer.waitForClient();
    await pushUntil(push(0, 0, 0), () => s.store.snapshot.taskId === TASK && s.store.snapshot.layer.current === 0);
    await pushUntil(push(1, 30, 2), () => s.store.snapshot.layer.current === 1);
    await pushUntil(push(2, 60, 4), () => s.store.snapshot.layer.current === 2);
    const last = push(40, 910, 93);
    await pushUntil(last, () => s.store.snapshot.remaining === 590);
    for (let i = 0; i < 5; i++) printer.push(last);
    await new Promise((resolve) => setTimeout(resolve, 100));
    return ntfy.requests.map((r) => (r.json as { title: string }).title);
  }

  it("sends one first-layer and one almost-done Notification, in that order, with both on", async () => {
    const events = { ...defaultConfig().events, "first-layer": true, "almost-done": true };
    const titles = await runAJob(events);
    assert.deepEqual(
      titles.filter((t) => t === "First layer done" || t === "Almost done"),
      ["First layer done", "Almost done"],
    );
    const almost = ntfy.requests.find((r) => (r.json as { title: string }).title === "Almost done");
    assert.equal((almost?.json as { message: string }).message, "test-print-1.gcode has about 10 min left (93%).");
  });

  it("sends neither with the default event settings", async () => {
    const titles = await runAJob(defaultConfig().events);
    assert.deepEqual(
      titles.filter((t) => t === "First layer done" || t === "Almost done"),
      [],
    );
  });
});
