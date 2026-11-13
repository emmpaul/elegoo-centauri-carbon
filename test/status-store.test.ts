import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import type { SdcpResponse, StatusMessage } from "../src/sdcp-client.ts";
import { emptySnapshot, type StatusSnapshot, StatusStore } from "../src/status-store.ts";
import { loadFixture } from "./support/fake-printer.ts";

const T = 1_794_605_000_000;

function statusFrame(fixture: string, seq: number): StatusMessage {
  const frame = loadFixture(fixture).frames.find((f) => f.seq === seq);
  assert.ok(frame && typeof frame.payload === "object" && frame.payload !== null && "Status" in frame.payload, `${fixture}#${seq} is a status push`);
  return structuredClone(frame.payload) as StatusMessage;
}

function snapshotOf(message: StatusMessage): StatusSnapshot {
  const store = new StatusStore();
  store.setConnection("online");
  store.applyStatus(message, T);
  return store.snapshot;
}

describe("StatusStore with recorded status pushes", () => {
  it("idle (connect-idle.json#27)", () => {
    assert.deepEqual(snapshotOf(statusFrame("connect-idle.json", 27)), {
      connection: "online",
      machineState: { name: "idle", code: 0 },
      printState: { name: "idle", code: 0 },
      taskId: null,
      fileName: null,
      progress: 0,
      layer: { current: 12, total: 12 },
      elapsed: 398,
      remaining: 1,
      temperatures: {
        nozzle: { current: 157.7, target: 0 },
        bed: { current: 60.8, target: 0 },
        chamber: { current: 28.7, target: 0 },
      },
      light: "on",
      errorCode: null,
      updatedAt: T,
    });
  });

  it("printing (connect-printing.json#9)", () => {
    assert.deepEqual(snapshotOf(statusFrame("connect-printing.json", 9)), {
      connection: "online",
      machineState: { name: "printing", code: 1 },
      printState: { name: "printing", code: 13 },
      taskId: "c735768d-8d67-4ae2-8d07-05c0c05c4aa2",
      fileName: "test-print-2.gcode",
      progress: 53,
      layer: { current: 9, total: 12 },
      elapsed: 306,
      remaining: 93,
      temperatures: {
        nozzle: { current: 250.8, target: 250 },
        bed: { current: 70, target: 70 },
        chamber: { current: 29.5, target: 0 },
      },
      light: "on",
      errorCode: null,
      updatedAt: T,
    });
  });

  it("paused (control-pause-resume-light.json#16)", () => {
    assert.deepEqual(snapshotOf(statusFrame("control-pause-resume-light.json", 16)), {
      connection: "online",
      machineState: { name: "printing", code: 1 },
      printState: { name: "paused", code: 6 },
      taskId: "9f0f4d7e-826e-45df-998e-ea24f6815410",
      fileName: "test-print-5.gcode",
      progress: 0,
      layer: { current: 5, total: 640 },
      elapsed: 251,
      remaining: 12568,
      temperatures: {
        nozzle: { current: 210.3, target: 210 },
        bed: { current: 60, target: 60 },
        chamber: { current: 30.6, target: 0 },
      },
      light: "on",
      errorCode: null,
      updatedAt: T,
    });
  });

  it("completed (print-complete.json#24) shows 100 % although the printer resets Progress to 0", () => {
    assert.deepEqual(snapshotOf(statusFrame("print-complete.json", 24)), {
      connection: "online",
      machineState: { name: "idle", code: 0 },
      printState: { name: "completed", code: 9 },
      taskId: null,
      fileName: null,
      progress: 100,
      layer: { current: 12, total: 12 },
      elapsed: 398,
      remaining: 1,
      temperatures: {
        nozzle: { current: 250, target: 0 },
        bed: { current: 69.6, target: 0 },
        chamber: { current: 31.6, target: 0 },
      },
      light: "on",
      errorCode: null,
      updatedAt: T,
    });
  });

  it("light off (control-pause-resume-light.json#28)", () => {
    assert.equal(snapshotOf(statusFrame("control-pause-resume-light.json", 28)).light, "off");
  });

  it("pausing and resume preparation (control-pause-resume-light.json#12, #17)", () => {
    assert.deepEqual(snapshotOf(statusFrame("control-pause-resume-light.json", 12)).printState, { name: "pausing", code: 5 });
    assert.deepEqual(snapshotOf(statusFrame("control-pause-resume-light.json", 17)).printState, { name: "preparing", code: 20 });
  });

  it("material change mid-job (connect-loading.json#11) counts as an active job", () => {
    const snapshot = snapshotOf(statusFrame("connect-loading.json", 11));
    assert.deepEqual(snapshot.machineState, { name: "loading-material", code: 10 });
    assert.deepEqual(snapshot.printState, { name: "preparing", code: 16 });
  });

  it("follows a whole recorded job end (print-complete.json) to completed", () => {
    const store = new StatusStore();
    for (const frame of loadFixture("print-complete.json").frames) {
      if (frame.direction === "received" && typeof frame.payload === "object" && frame.payload !== null && "Status" in frame.payload) {
        store.applyStatus(frame.payload as StatusMessage, T);
      }
    }
    assert.equal(store.snapshot.printState.name, "completed");
  });
});

function taskDetailFrame(fixture: string, seq: number): SdcpResponse {
  const frame = loadFixture(fixture).frames.find((f) => f.seq === seq);
  assert.ok(frame && typeof frame.payload === "object" && frame.payload !== null && "Data" in frame.payload, `${fixture}#${seq} is a response`);
  return structuredClone(frame.payload) as SdcpResponse;
}

/**
 * SYNTHETIC: no error frame has been recorded. This Cmd 321 answer is built
 * from the documented shape (docs/sdcp-protocol.md, Cmd 321 row and "Error
 * codes"); 45 is the one ErrorStatusReason code the web UI names.
 */
function syntheticTaskDetail(taskId: string, errorStatusReason: number): SdcpResponse {
  return {
    Id: "00000000000000000000000000000000",
    Data: {
      Cmd: 321,
      Data: {
        Ack: 0,
        HistoryDetailList: [
          {
            TaskId: taskId,
            TaskName: "/local/test-print-2.gcode",
            BeginTime: 1794604720,
            EndTime: 1794605000,
            TaskStatus: 4,
            AlreadyPrintLayer: 9,
            ErrorStatusReason: errorStatusReason,
          },
        ],
      },
      RequestID: "00000000000000000000000000000000",
      MainboardID: "",
      TimeStamp: 1794605000,
    },
    Topic: "sdcp/response/",
  };
}

describe("StatusStore error code from Cmd 321 task detail", () => {
  const printingTaskId = "c735768d-8d67-4ae2-8d07-05c0c05c4aa2";

  it("error (synthetic Cmd 321 answer) keeps the raw ErrorStatusReason", () => {
    const store = new StatusStore();
    store.setConnection("online");
    store.applyStatus(statusFrame("connect-printing.json", 9), T);
    const changes: StatusSnapshot[] = [];
    store.on("change", (snapshot) => changes.push(snapshot));
    store.applyTaskDetail(syntheticTaskDetail(printingTaskId, 45));
    assert.equal(changes.length, 1);
    assert.deepEqual(store.snapshot, {
      connection: "online",
      machineState: { name: "printing", code: 1 },
      printState: { name: "printing", code: 13 },
      taskId: printingTaskId,
      fileName: "test-print-2.gcode",
      progress: 53,
      layer: { current: 9, total: 12 },
      elapsed: 306,
      remaining: 93,
      temperatures: {
        nozzle: { current: 250.8, target: 250 },
        bed: { current: 70, target: 70 },
        chamber: { current: 29.5, target: 0 },
      },
      light: "on",
      errorCode: 45,
      updatedAt: T,
    });
  });

  it("keeps the error code across later status pushes of the same job", () => {
    const store = new StatusStore();
    store.applyStatus(statusFrame("connect-printing.json", 9), T);
    store.applyTaskDetail(syntheticTaskDetail(printingTaskId, 45));
    store.applyStatus(statusFrame("connect-printing.json", 9), T + 1);
    assert.equal(store.snapshot.errorCode, 45);
  });

  it("clears the error code when a new job starts", () => {
    const store = new StatusStore();
    store.applyStatus(statusFrame("connect-printing.json", 9), T);
    store.applyTaskDetail(syntheticTaskDetail(printingTaskId, 45));
    store.applyStatus(statusFrame("control-pause-resume-light.json", 16), T + 1);
    assert.equal(store.snapshot.errorCode, null);
  });

  it("ignores entries for other tasks and other commands", () => {
    const store = new StatusStore();
    store.applyStatus(statusFrame("connect-printing.json", 9), T);
    store.applyTaskDetail(syntheticTaskDetail("27febebe-8552-40e8-9e82-086c014a5502", 45));
    const other = syntheticTaskDetail(printingTaskId, 45);
    other.Data.Cmd = 320;
    store.applyTaskDetail(other);
    assert.equal(store.snapshot.errorCode, null);
  });

  it("ignores a task detail before any job is known", () => {
    const store = new StatusStore();
    store.applyTaskDetail(syntheticTaskDetail(printingTaskId, 45));
    assert.equal(store.snapshot.errorCode, null);
  });

  it("reads 0 (no error) for the completed job (print-complete.json#28) after TaskId leaves the pushes", () => {
    const store = new StatusStore();
    for (const frame of loadFixture("print-complete.json").frames) {
      if (frame.seq > 24) break;
      if (frame.direction === "received" && typeof frame.payload === "object" && frame.payload !== null && "Status" in frame.payload) {
        store.applyStatus(frame.payload as StatusMessage, T);
      }
    }
    assert.equal(store.snapshot.taskId, null);
    store.applyTaskDetail(taskDetailFrame("print-complete.json", 28));
    assert.equal(store.snapshot.errorCode, 0);
    assert.equal(store.snapshot.printState.name, "completed");
  });
});

describe("StatusStore with codes the reference does not list", () => {
  it("maps them to unknown and keeps the raw code", () => {
    const message = statusFrame("connect-printing.json", 9);
    message.Status.CurrentStatus = [4];
    (message.Status.PrintInfo as Record<string, unknown>).Status = 99;
    const snapshot = snapshotOf(message);
    assert.deepEqual(snapshot.machineState, { name: "unknown", code: 4 });
    assert.deepEqual(snapshot.printState, { name: "unknown", code: 99 });
  });

  it("maps print state 7 (unlabelled in the reference) to unknown", () => {
    const message = statusFrame("connect-printing.json", 9);
    (message.Status.PrintInfo as Record<string, unknown>).Status = 7;
    assert.deepEqual(snapshotOf(message).printState, { name: "unknown", code: 7 });
  });
});

describe("StatusStore updates", () => {
  it("starts empty and connecting", () => {
    assert.deepEqual(new StatusStore().snapshot, emptySnapshot());
  });

  it("emits a change synchronously for each push and keeps fields a partial push leaves out", () => {
    const store = new StatusStore();
    const changes: StatusSnapshot[] = [];
    store.on("change", (snapshot) => changes.push(snapshot));
    store.applyStatus(statusFrame("connect-printing.json", 9), T);
    store.applyStatus({ ...statusFrame("connect-printing.json", 9), Status: { PrintInfo: { Progress: 60 } } }, T + 1);
    assert.equal(changes.length, 2);
    assert.equal(changes[1]?.progress, 60);
    assert.equal(changes[1]?.fileName, "test-print-2.gcode");
    assert.equal(changes[1]?.temperatures.nozzle.target, 250);
  });

  it("follows a session's connection state and status pushes", () => {
    const session = new EventEmitter();
    const store = new StatusStore();
    store.attach(session as never);
    session.emit("state", "online");
    session.emit("status", statusFrame("connect-printing.json", 9));
    assert.equal(store.snapshot.connection, "online");
    assert.equal(store.snapshot.printState.name, "printing");
    session.emit("state", "offline");
    assert.equal(store.snapshot.connection, "offline");
    assert.equal(store.snapshot.printState.name, "printing", "last known state is kept while offline");
  });
});
