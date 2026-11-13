import { strict as assert } from "node:assert";
import { once } from "node:events";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { backoffDelay, type ConnectionState, PrinterSession } from "../src/printer-session.ts";
import { Cmd, type Logger } from "../src/sdcp-client.ts";
import { FakePrinter, type FixtureFrame, loadFixture } from "./support/fake-printer.ts";

const quiet: Logger = { info: () => {}, warn: () => {}, error: () => {} };

const statusPush = (() => {
  const frame = loadFixture("connect-idle.json").frames.find((f: FixtureFrame) =>
    String((f.payload as { Topic?: string }).Topic).startsWith("sdcp/status/"),
  );
  assert.ok(frame, "connect-idle.json has a status push");
  return frame.payload;
})();

/** Lets pending I/O callbacks (socket events) run while timers are mocked. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

function isCmd(cmd: number) {
  return (frame: { payload: unknown }) => (frame.payload as { Data?: { Cmd?: number } }).Data?.Cmd === cmd;
}

describe("backoffDelay", () => {
  it("doubles from 1 s and caps at 60 s", () => {
    assert.deepEqual(
      [0, 1, 2, 3, 4, 5, 6, 7, 20, 1000].map((attempt) => backoffDelay(attempt)),
      [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000, 60000],
    );
  });
});

describe("PrinterSession", () => {
  let printer: FakePrinter;
  let session: PrinterSession;
  let states: ConnectionState[];

  beforeEach(async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    printer = await FakePrinter.start();
    session = new PrinterSession({ url: printer.url, logger: quiet });
    states = [];
    session.on("state", (state) => states.push(state));
  });

  afterEach(async () => {
    session.stop();
    await printer.close();
    mock.timers.reset();
  });

  /** Starts the session and brings it online with one status push. */
  async function goOnline(): Promise<void> {
    const statusRequest = printer.nextFrame(isCmd(Cmd.GET_PRINTER_STATUS));
    session.start();
    await statusRequest;
    const status = once(session, "status");
    printer.push(statusPush);
    await status;
    assert.equal(session.state, "online");
  }

  it("asks for status and attributes on connect and goes online on the first status push", async () => {
    assert.equal(session.state, "connecting");
    await goOnline();
    await settle();
    assert.deepEqual(printer.receivedCommands, [Cmd.GET_PRINTER_STATUS, Cmd.GET_PRINTER_ATTR]);
    assert.deepEqual(states, ["online"]);
  });

  it("goes offline on a drop, reconnects after the back-off, and is online again after a status push", async () => {
    await goOnline();
    const offline = once(session, "state");
    printer.dropClients();
    assert.deepEqual(await offline, ["offline"]);

    // No reconnect before the first back-off delay (1 s) has passed.
    mock.timers.tick(999);
    await settle();
    assert.equal(printer.clientCount, 0);

    const reconnected = printer.nextFrame(isCmd(Cmd.GET_PRINTER_STATUS));
    mock.timers.tick(1);
    await reconnected;
    assert.equal(session.state, "offline", "connected but no status yet");

    const online = once(session, "state");
    printer.push(statusPush);
    assert.deepEqual(await online, ["online"]);
    assert.deepEqual(states, ["online", "offline", "online"]);
  });

  it("requests status after 30 s without a status message, and again after another 30 s", async () => {
    await goOnline();
    await settle();
    const polls = () => printer.receivedCommands.filter((cmd) => cmd === Cmd.GET_PRINTER_STATUS).length;
    assert.equal(polls(), 1);

    mock.timers.tick(29_999);
    await settle();
    assert.equal(polls(), 1);

    let poll = printer.nextFrame(isCmd(Cmd.GET_PRINTER_STATUS));
    mock.timers.tick(1);
    await poll;
    assert.equal(polls(), 2);

    poll = printer.nextFrame(isCmd(Cmd.GET_PRINTER_STATUS));
    mock.timers.tick(30_000);
    await poll;
    assert.equal(polls(), 3);
  });

  it("does not poll while status messages keep arriving", async () => {
    await goOnline();
    for (let i = 0; i < 4; i++) {
      mock.timers.tick(20_000);
      const status = once(session, "status");
      printer.push(statusPush);
      await status;
    }
    await settle();
    assert.equal(printer.receivedCommands.filter((cmd) => cmd === Cmd.GET_PRINTER_STATUS).length, 1);
  });
});
