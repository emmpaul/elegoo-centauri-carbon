import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { EventDetector, type EventDetectorOptions, type PrintEvent } from "../src/event-detector.ts";
import type { Logger, StatusMessage } from "../src/sdcp-client.ts";
import { type Service, startService } from "../src/service.ts";
import { StatusStore } from "../src/status-store.ts";
import { FakePrinter, loadFixture } from "./support/fake-printer.ts";

const T = 1_794_605_000_000;
const COMPLETED_TASK = "c735768d-8d67-4ae2-8d07-05c0c05c4aa2";
const PAUSED_TASK = "9f0f4d7e-826e-45df-998e-ea24f6815410";

/** Status pushes of a fixture, in recorded order, optionally limited to a seq range. */
function statusFrames(fixture: string, from = 0, to = Infinity): StatusMessage[] {
  return loadFixture(fixture)
    .frames.filter((f) => f.direction === "received" && f.seq >= from && f.seq <= to)
    .map((f) => f.payload)
    .filter((p): p is StatusMessage => typeof p === "object" && p !== null && "Status" in p)
    .map((p) => structuredClone(p));
}

function statusFrame(fixture: string, seq: number): StatusMessage {
  const [frame] = statusFrames(fixture, seq, seq);
  assert.ok(frame, `${fixture}#${seq} is a status push`);
  return frame;
}

/** A status push with `PrintInfo` and `CurrentStatus` changed. */
function withPrint(message: StatusMessage, machine: number, info: Record<string, unknown>): StatusMessage {
  const copy = structuredClone(message);
  copy.Status.CurrentStatus = [machine];
  copy.Status.PrintInfo = { ...(copy.Status.PrintInfo as Record<string, unknown>), ...info };
  return copy;
}

function silentLogger(): Logger & { warnings: string[] } {
  const warnings: string[] = [];
  return { warnings, info() {}, warn: (m) => warnings.push(m), error: (m) => warnings.push(m) };
}

/** A store and a detector attached to it, collecting events. */
function setup(options: EventDetectorOptions = {}) {
  const store = new StatusStore();
  store.setConnection("online");
  const detector = new EventDetector({ now: () => T, logger: silentLogger(), ...options });
  const events: PrintEvent[] = [];
  detector.on("event", (event) => events.push(event));
  detector.attach(store);
  const apply = (messages: StatusMessage[]) => {
    for (const message of messages) store.applyStatus(message, T);
  };
  return { store, detector, events, apply };
}

/** Lets the detector's end-of-job lookup settle. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

const types = (events: PrintEvent[]) => events.map((e) => e.type);

describe("EventDetector with recorded status pushes", () => {
  it("emits one finished event with file name and duration when a job completes (print-complete.json)", async () => {
    const { events, apply, detector } = setup();
    apply(statusFrames("print-complete.json"));
    await settle();
    assert.deepEqual(events, [
      {
        type: "finished",
        at: T,
        printerName: null,
        jobId: COMPLETED_TASK,
        fileName: "test-print-2.gcode",
        progress: 100,
        durationSeconds: 398,
        errorCode: null,
      },
    ]);
    detector.close();
  });

  it("sends no second finished event when the session reconnects during the completed state", async () => {
    const { store, events, apply, detector } = setup();
    apply(statusFrames("print-complete.json"));
    await settle();
    store.setConnection("offline");
    store.setConnection("connecting");
    apply(statusFrames("print-complete.json", 24));
    store.setConnection("online");
    apply(statusFrames("print-complete.json", 24));
    await settle();
    assert.deepEqual(types(events), ["finished"]);
    detector.close();
  });

  it("emits started once the new job's id shows up, not for a job already running at connect (connect-idle.json)", () => {
    const { events, apply, detector } = setup();
    apply(statusFrames("connect-idle.json", 0, 33));
    assert.deepEqual(events, [], "no job identity yet at #33");
    apply(statusFrames("connect-idle.json", 34));
    assert.deepEqual(events, [
      {
        type: "started",
        at: T,
        printerName: null,
        jobId: PAUSED_TASK,
        fileName: "test-print-5.gcode",
        progress: 0,
        durationSeconds: 0,
        errorCode: null,
      },
    ]);
    detector.close();
  });

  it("emits paused once per pause, through repeated pushes and a resume (control-pause-resume-light.json)", () => {
    const { events, apply, detector } = setup();
    apply(statusFrames("control-pause-resume-light.json"));
    assert.deepEqual(types(events), ["paused"], "joined mid-job: no started; one pause");
    assert.equal(events[0]?.fileName, "test-print-5.gcode");
    assert.equal(events[0]?.jobId, PAUSED_TASK);
    // A second pause of the same job is a new occurrence.
    apply([statusFrame("control-pause-resume-light.json", 12), statusFrame("control-pause-resume-light.json", 16)]);
    apply([statusFrame("control-pause-resume-light.json", 16)]);
    assert.deepEqual(types(events), ["paused", "paused"]);
    detector.close();
  });

  it("does not emit paused for a job that is already paused at connect", () => {
    const { events, apply, detector } = setup();
    apply([statusFrame("control-pause-resume-light.json", 16), statusFrame("control-pause-resume-light.json", 16)]);
    assert.deepEqual(events, []);
    detector.close();
  });

  for (const code of [8, 14]) {
    it(`emits stopped once when the job ends in print state ${code} (static-only code)`, async () => {
      const { events, apply, detector } = setup();
      const printing = statusFrame("control-pause-resume-light.json", 11);
      const ended = { TaskId: "", Filename: "", Progress: 0 };
      apply([printing, withPrint(printing, 0, { ...ended, Status: 1 }), withPrint(printing, 0, { ...ended, Status: code })]);
      apply([withPrint(printing, 0, { ...ended, Status: code })]);
      await settle();
      assert.deepEqual(types(events), ["stopped"]);
      assert.equal(events[0]?.fileName, "test-print-5.gcode");
      assert.equal(events[0]?.jobId, PAUSED_TASK);
      detector.close();
    });
  }

  it("emits nothing for a job that had already completed before the first push", async () => {
    const { events, apply, detector } = setup();
    apply(statusFrames("print-complete.json", 24));
    await settle();
    assert.deepEqual(events, []);
    detector.close();
  });
});

describe("EventDetector failed events", () => {
  it("turns a job end into failed with file name, progress, and the raw error code from the task detail", async () => {
    const asked: string[] = [];
    const { events, apply, detector } = setup({
      taskErrorCode: async (taskId) => {
        asked.push(taskId);
        return 45;
      },
    });
    apply(statusFrames("print-complete.json"));
    await settle();
    assert.deepEqual(asked, [COMPLETED_TASK]);
    assert.deepEqual(events, [
      {
        type: "failed",
        at: T,
        printerName: null,
        jobId: COMPLETED_TASK,
        fileName: "test-print-2.gcode",
        progress: 92,
        durationSeconds: 398,
        errorCode: 45,
      },
    ]);
    detector.close();
  });

  it("reports finished when the task detail shows error code 0", async () => {
    const { events, apply, detector } = setup({ taskErrorCode: async () => 0 });
    apply(statusFrames("print-complete.json"));
    await settle();
    assert.deepEqual(types(events), ["finished"]);
    detector.close();
  });

  it("falls back to the snapshot and logs a warning when the task detail cannot be read", async () => {
    const logger = silentLogger();
    const { events, apply, detector } = setup({
      logger,
      taskErrorCode: async () => {
        throw new Error("timeout");
      },
    });
    apply(statusFrames("print-complete.json"));
    await settle();
    assert.deepEqual(types(events), ["finished"]);
    assert.match(logger.warnings.join("\n"), /error code of job c735768d.*timeout/);
    detector.close();
  });

  it("emits failed once when the store learns a non-zero error code while the job runs", () => {
    const { store, events, apply, detector } = setup();
    apply(statusFrames("connect-printing.json"));
    const answer = loadFixture("print-complete.json").frames.find((f) => f.seq === 28)?.payload as Parameters<StatusStore["applyTaskDetail"]>[0];
    const detail = structuredClone(answer);
    const list = detail.Data.Data.HistoryDetailList as Record<string, unknown>[];
    list[0] = { ...list[0], ErrorStatusReason: 45 };
    store.applyTaskDetail(detail);
    apply(statusFrames("connect-printing.json", 40));
    assert.deepEqual(types(events), ["failed"]);
    assert.equal(events[0]?.errorCode, 45);
    assert.equal(events[0]?.fileName, "test-print-2.gcode");
    detector.close();
  });
});

describe("EventDetector offline and online", () => {
  beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
  afterEach(() => mock.timers.reset());

  it("sends nothing for a 90 s blip", () => {
    const { store, events, detector } = setup();
    store.setConnection("offline");
    mock.timers.tick(60_000);
    store.setConnection("connecting");
    mock.timers.tick(30_000);
    store.setConnection("online");
    mock.timers.tick(300_000);
    assert.deepEqual(events, []);
    detector.close();
  });

  it("emits offline after 2 minutes unreachable, then online when the session is back, once each per outage", () => {
    const { store, events, detector } = setup();
    store.setConnection("offline");
    mock.timers.tick(119_999);
    assert.deepEqual(events, []);
    mock.timers.tick(1);
    assert.deepEqual(types(events), ["offline"]);
    store.setConnection("connecting");
    store.setConnection("offline");
    mock.timers.tick(600_000);
    assert.deepEqual(types(events), ["offline"], "one offline per outage");
    store.setConnection("online");
    assert.deepEqual(types(events), ["offline", "online"]);
    store.setConnection("offline");
    mock.timers.tick(120_000);
    store.setConnection("online");
    assert.deepEqual(types(events), ["offline", "online", "offline", "online"]);
    detector.close();
  });

  it("counts a printer that never answers since start as offline", () => {
    const store = new StatusStore();
    const detector = new EventDetector({ logger: silentLogger() });
    const events: PrintEvent[] = [];
    detector.on("event", (event) => events.push(event));
    detector.attach(store);
    mock.timers.tick(120_000);
    assert.deepEqual(types(events), ["offline"]);
    detector.close();
  });

  it("cancels the pending offline timer on close", () => {
    const { store, events, detector } = setup();
    store.setConnection("offline");
    detector.close();
    mock.timers.tick(600_000);
    assert.deepEqual(events, []);
  });
});

describe("EventDetector in the service, against the fake printer", () => {
  let printer: FakePrinter;
  let service: Service | undefined;
  const requested: unknown[] = [];

  beforeEach(async () => {
    requested.length = 0;
    printer = await FakePrinter.start({
      replies: {
        321: (data) => {
          requested.push(data.Id);
          const ids = Array.isArray(data.Id) ? data.Id : [];
          return { Ack: 0, HistoryDetailList: ids.map((id) => ({ TaskId: id, TaskStatus: 1, ErrorStatusReason: 45 })) };
        },
      },
    });
  });

  afterEach(async () => {
    await service?.close();
    service = undefined;
    await printer.close();
  });

  async function start(): Promise<PrintEvent[]> {
    service = await startService({
      printerUrl: printer.url,
      cameraUrl: "http://127.0.0.1:9/video",
      listen: { host: "127.0.0.1", port: 0 },
      token: null,
      logger: silentLogger(),
    });
    const events: PrintEvent[] = [];
    service.detector.on("event", (event) => events.push(event));
    await printer.waitForClient();
    return events;
  }

  async function pushUntil(message: StatusMessage, done: () => boolean): Promise<void> {
    for (let i = 0; i < 200 && !done(); i++) {
      printer.push(message);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(done(), "condition reached");
  }

  it("asks for the task detail (Cmd 321) when the job ends and reports failed with the raw error code", async () => {
    const events = await start();
    const s = service as Service;
    await pushUntil(statusFrame("print-complete.json", 23), () => s.store.snapshot.taskId === COMPLETED_TASK);
    await pushUntil(statusFrame("print-complete.json", 24), () => events.length > 0);
    assert.deepEqual(requested, [[COMPLETED_TASK]]);
    assert.deepEqual(types(events), ["failed"]);
    assert.equal(events[0]?.errorCode, 45);
    assert.equal(events[0]?.fileName, "test-print-2.gcode");
    assert.equal(events[0]?.progress, 92);
    assert.equal(s.store.snapshot.errorCode, 45, "the store takes the error code too");
  });

  it("sends no duplicate after the printer drops the session and still reports the job completed", async () => {
    printer.replies.set(321, (data) => ({
      Ack: 0,
      HistoryDetailList: (data.Id as string[]).map((id) => ({ TaskId: id, ErrorStatusReason: 0 })),
    }));
    const events = await start();
    const s = service as Service;
    await pushUntil(statusFrame("print-complete.json", 23), () => s.store.snapshot.taskId === COMPLETED_TASK);
    await pushUntil(statusFrame("print-complete.json", 24), () => events.length > 0);
    printer.dropClients();
    await pushUntil(statusFrame("print-complete.json", 24), () => s.store.snapshot.connection === "offline");
    // The session reconnects after its 1 s back-off and takes the completed push again.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await pushUntil(statusFrame("print-complete.json", 24), () => s.store.snapshot.connection === "online");
    printer.push(statusFrame("print-complete.json", 29));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(types(events), ["finished"]);
    assert.equal(printer.receivedCommands.filter((cmd) => cmd === 321).length, 1, "one task detail request, for the one job end");
  });
});
