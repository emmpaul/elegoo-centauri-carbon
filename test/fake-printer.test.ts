import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import { FakePrinter, FIXTURE_MAINBOARD_ID, loadFixture } from "./support/fake-printer.ts";

/** Opens a client with Node's built-in WebSocket and collects parsed frames. */
async function connect(url: string): Promise<{ socket: WebSocket; frames: unknown[]; next: () => Promise<unknown> }> {
  const socket = new WebSocket(url);
  const frames: unknown[] = [];
  const waiters: ((frame: unknown) => void)[] = [];
  socket.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data)) as unknown;
    const waiter = waiters.shift();
    if (waiter) waiter(frame);
    else frames.push(frame);
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("connect failed")), { once: true });
  });
  const next = () =>
    frames.length > 0 ? Promise.resolve(frames.shift()) : new Promise<unknown>((resolve) => waiters.push(resolve));
  return { socket, frames, next };
}

function request(cmd: number, requestId: string): string {
  return JSON.stringify({
    Id: "",
    Data: { Cmd: cmd, Data: {}, RequestID: requestId, MainboardID: "", TimeStamp: Date.now(), From: 1 },
  });
}

describe("fake printer", () => {
  let printer: FakePrinter;

  before(async () => {
    printer = await FakePrinter.start({ replies: { 129: 3, 130: "silent" } });
  });

  after(async () => {
    await printer.close();
  });

  it("accepts a connection, records frames, and answers with the request's RequestID", async () => {
    const client = await connect(printer.url);
    try {
      client.socket.send("ping");
      client.socket.send(request(0, "a".repeat(32)));
      const response = (await client.next()) as { Topic: string; Data: { Cmd: number; RequestID: string; Data: { Ack: number } } };
      assert.equal(response.Topic, `sdcp/response/${FIXTURE_MAINBOARD_ID}`);
      assert.equal(response.Data.Cmd, 0);
      assert.equal(response.Data.RequestID, "a".repeat(32));
      assert.equal(response.Data.Data.Ack, 0);
      assert.equal(printer.received[0]?.payload, "ping");
      assert.deepEqual(printer.receivedCommands.slice(-1), [0]);
    } finally {
      client.socket.close();
    }
  });

  it("answers with a configured Ack, or not at all", async () => {
    const client = await connect(printer.url);
    try {
      client.socket.send(request(130, "b".repeat(32)));
      client.socket.send(request(129, "c".repeat(32)));
      const response = (await client.next()) as { Data: { Cmd: number; Data: { Ack: number } } };
      assert.equal(response.Data.Cmd, 129);
      assert.equal(response.Data.Data.Ack, 3);
      assert.equal(client.frames.length, 0);
    } finally {
      client.socket.close();
    }
  });

  it("replays the pushes of a fixture, without its responses", async () => {
    const client = await connect(printer.url);
    try {
      const fixture = loadFixture("connect-printing.json");
      const count = printer.replay(fixture);
      const expected = fixture.frames.filter(
        (f) => f.direction === "received" && !String((f.payload as { Topic?: string }).Topic).startsWith("sdcp/response/"),
      );
      assert.ok(count > 0);
      assert.equal(count, expected.length);
      const first = await client.next();
      assert.deepEqual(first, expected[0]?.payload);
    } finally {
      client.socket.close();
    }
  });
});
