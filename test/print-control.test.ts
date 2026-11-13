import { strict as assert } from "node:assert";
import { once } from "node:events";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ControlRejectedError, isAllowed, PrintControl } from "../src/print-control.ts";
import { PrinterSession } from "../src/printer-session.ts";
import { Cmd, type Logger } from "../src/sdcp-client.ts";
import { emptySnapshot, type StatusSnapshot, StatusStore } from "../src/status-store.ts";
import { FakePrinter, loadFixture } from "./support/fake-printer.ts";

const quiet: Logger = { info: () => {}, warn: () => {}, error: () => {} };
const CONNECT_COMMANDS = [Cmd.GET_PRINTER_STATUS, Cmd.GET_PRINTER_ATTR];

/** A recorded status push: `fixture#seq`. */
function statusPush(fixture: string, seq: number): unknown {
  const frame = loadFixture(fixture).frames.find((f) => f.seq === seq);
  assert.ok(frame && typeof frame.payload === "object" && frame.payload !== null && "Status" in frame.payload, `${fixture}#${seq} is a status push`);
  return frame.payload;
}

const PRINTING = ["control-pause-resume-light.json", 11] as const; // 1/13, light on
const PAUSING = ["control-pause-resume-light.json", 12] as const; // 1/5
const PAUSED = ["control-pause-resume-light.json", 16] as const; // 1/6
const RESUMED = ["control-pause-resume-light.json", 26] as const; // 1/13 after resume
const LIGHT_OFF = ["control-pause-resume-light.json", 28] as const; // SecondLight 0
const IDLE = ["connect-idle.json", 27] as const; // 0/0
const COMPLETED = ["print-complete.json", 24] as const; // 0/9

function isCmd(cmd: number) {
  return (frame: { payload: unknown }) => (frame.payload as { Data?: { Cmd?: number } }).Data?.Cmd === cmd;
}

describe("PrintControl against the fake printer", () => {
  let printer: FakePrinter;
  let session: PrinterSession;
  let store: StatusStore;
  let control: PrintControl;

  beforeEach(async () => {
    printer = await FakePrinter.start();
    session = new PrinterSession({ url: printer.url, logger: quiet });
    store = new StatusStore();
    store.attach(session);
    control = new PrintControl(session, store);
  });

  afterEach(async () => {
    session.stop();
    await printer.close();
  });

  /** Pushes a recorded status and waits until the store has applied it. */
  async function pushStatus([fixture, seq]: readonly [string, number]): Promise<StatusSnapshot> {
    const change = once(store, "change");
    printer.push(statusPush(fixture, seq));
    const [snapshot] = (await change) as [StatusSnapshot];
    return snapshot;
  }

  /** Connects, answers the connect requests, and applies one status push. */
  async function goOnline(status: readonly [string, number]): Promise<void> {
    const attributesRequest = printer.nextFrame(isCmd(Cmd.GET_PRINTER_ATTR));
    session.start();
    await attributesRequest;
    await pushStatus(status);
    assert.equal(store.snapshot.connection, "online");
  }

  /**
   * Every command id the fake received after the connect requests. A Cmd 0
   * round-trip first makes sure any earlier frame on the socket has landed.
   */
  async function commandsSent(): Promise<number[]> {
    await session.send(Cmd.GET_PRINTER_STATUS);
    const received = printer.receivedCommands;
    assert.deepEqual(received.slice(0, 2), CONNECT_COMMANDS);
    return received.slice(2, -1);
  }

  async function assertRejected(promise: Promise<unknown>, reason: "not-allowed" | "confirmation-required"): Promise<void> {
    await assert.rejects(promise, (error: unknown) => error instanceof ControlRejectedError && error.reason === reason);
  }

  it("pauses a running print, and the snapshot shows it pausing", async () => {
    await goOnline(PRINTING);
    const response = await control.pause();
    assert.equal(response.Data.Cmd, Cmd.SEND_PRINTER_SUSPEND_PRINT);
    assert.deepEqual(await commandsSent(), [Cmd.SEND_PRINTER_SUSPEND_PRINT]);
    assert.equal((await pushStatus(PAUSING)).printState.name, "pausing");
  });

  it("resumes a paused print, and the snapshot shows it printing", async () => {
    await goOnline(PAUSED);
    await control.resume();
    assert.deepEqual(await commandsSent(), [Cmd.SEND_PRINTER_RESTORE_PRINT]);
    assert.equal((await pushStatus(RESUMED)).printState.name, "printing");
  });

  it("stops a running print when confirmed", async () => {
    await goOnline(PRINTING);
    await control.stop({ confirm: true });
    assert.deepEqual(await commandsSent(), [Cmd.SEND_PRINTER_STOP_PRINT]);
  });

  it("stops a paused print when confirmed", async () => {
    await goOnline(PAUSED);
    await control.stop({ confirm: true });
    assert.deepEqual(await commandsSent(), [Cmd.SEND_PRINTER_STOP_PRINT]);
  });

  it("turns the light off with the whole LightStatus object, and the snapshot shows it off", async () => {
    await goOnline(PRINTING);
    const sent = printer.nextFrame(isCmd(Cmd.EDIT_PRINTER_STATUS_DATA));
    await control.setLight(false);
    const frame = (await sent).payload as { Data: { Data: unknown } };
    assert.deepEqual(frame.Data.Data, { LightStatus: { SecondLight: 0, RgbLight: [0, 0, 0] } });
    assert.equal((await pushStatus(LIGHT_OFF)).light, "off");

    const on = printer.nextFrame(isCmd(Cmd.EDIT_PRINTER_STATUS_DATA));
    await control.setLight(true);
    assert.deepEqual(((await on).payload as { Data: { Data: unknown } }).Data.Data, {
      LightStatus: { SecondLight: 1, RgbLight: [0, 0, 0] },
    });
  });

  it("rejects stop without the confirmation flag and sends nothing", async () => {
    await goOnline(PRINTING);
    await assertRejected(control.stop(), "confirmation-required");
    await assertRejected(control.stop({}), "confirmation-required");
    await assertRejected(control.stop({ confirm: false }), "confirmation-required");
    assert.deepEqual(await commandsSent(), []);
    assert.equal(store.snapshot.printState.name, "printing");
  });

  it("rejects resume while printing, and pause while paused or pausing, sending nothing", async () => {
    await goOnline(PRINTING);
    await assertRejected(control.resume(), "not-allowed");
    await pushStatus(PAUSING);
    await assertRejected(control.pause(), "not-allowed");
    await assertRejected(control.resume(), "not-allowed");
    await assertRejected(control.stop({ confirm: true }), "not-allowed");
    await pushStatus(PAUSED);
    await assertRejected(control.pause(), "not-allowed");
    assert.deepEqual(await commandsSent(), []);
  });

  for (const [label, status] of [
    ["idle", IDLE],
    ["completed", COMPLETED],
  ] as const) {
    it(`rejects pause, resume, and stop while ${label}, sending nothing`, async () => {
      await goOnline(status);
      await assertRejected(control.pause(), "not-allowed");
      await assertRejected(control.resume(), "not-allowed");
      await assertRejected(control.stop({ confirm: true }), "not-allowed");
      assert.deepEqual(await commandsSent(), []);
    });
  }

  it("rejects every command while offline and sends nothing", async () => {
    await goOnline(PRINTING);
    const offline = once(session, "state");
    printer.dropClients();
    await offline;
    await assertRejected(control.pause(), "not-allowed");
    await assertRejected(control.stop({ confirm: true }), "not-allowed");
    await assertRejected(control.setLight(false), "not-allowed");
    assert.deepEqual(printer.receivedCommands, CONNECT_COMMANDS);
  });

  it("rejects the light before any status has arrived and sends nothing", async () => {
    const attributesRequest = printer.nextFrame(isCmd(Cmd.GET_PRINTER_ATTR));
    session.start();
    await attributesRequest;
    await assertRejected(control.setLight(true), "not-allowed");
    await assertRejected(control.pause(), "not-allowed");
    assert.deepEqual(await commandsSent(), []);
  });
});

describe("isAllowed", () => {
  const snapshot = (name: StatusSnapshot["printState"]["name"], code: number | null): StatusSnapshot => ({
    ...emptySnapshot("online"),
    printState: { name, code },
    light: "on",
  });

  it("refuses control in states the web UI blocks (pausing, restoring, unknown)", () => {
    for (const action of ["pause", "resume", "stop"] as const) {
      assert.equal(isAllowed(action, snapshot("pausing", 5)), false);
      assert.equal(isAllowed(action, snapshot("restoring", 12)), false);
      assert.equal(isAllowed(action, snapshot("unknown", 7)), false);
      assert.equal(isAllowed(action, snapshot("stopping", 1)), false);
      assert.equal(isAllowed(action, snapshot("stopped", 8)), false);
    }
  });

  it("allows pause and stop while preparing, and the light whenever online with a known light state", () => {
    assert.equal(isAllowed("pause", snapshot("preparing", 20)), true);
    assert.equal(isAllowed("stop", snapshot("preparing", 20)), true);
    assert.equal(isAllowed("light", snapshot("idle", 0)), true);
    assert.equal(isAllowed("light", { ...snapshot("idle", 0), light: "unknown" }), false);
    assert.equal(isAllowed("light", { ...snapshot("idle", 0), connection: "offline" }), false);
  });
});
