import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import { FakePrinter, FIXTURE_MAINBOARD_ID, loadFixture } from "./support/fake-printer.ts";
import { FakeThumbnails, fakePng } from "./support/fake-thumbnails.ts";

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

describe("fake printer history", () => {
  const entries = [
    { TaskId: "job-c", TaskName: "/local/test-print-3.gcode", TaskStatus: 4 },
    { TaskId: "job-b", TaskName: "/local/test-print-2.gcode", TaskStatus: 1 },
    { TaskId: "job-a", TaskName: "/local/test-print-1.gcode", TaskStatus: 3 },
  ];

  function historyRequest(cmd: number, requestId: string, data: Record<string, unknown>): string {
    return JSON.stringify({
      Id: "",
      Data: { Cmd: cmd, Data: data, RequestID: requestId, MainboardID: "", TimeStamp: Date.now(), From: 1 },
    });
  }

  it("lists the seeded ids for Cmd 320, in order", async () => {
    const printer = await FakePrinter.start({ history: { entries } });
    const client = await connect(printer.url);
    try {
      client.socket.send(historyRequest(320, "d".repeat(32), {}));
      const response = (await client.next()) as { Data: { Cmd: number; Data: { Ack: number; HistoryData: string[] } } };
      assert.equal(response.Data.Cmd, 320);
      assert.equal(response.Data.Data.Ack, 0);
      assert.deepEqual(response.Data.Data.HistoryData, ["job-c", "job-b", "job-a"]);
    } finally {
      client.socket.close();
      await printer.close();
    }
  });

  it("answers Cmd 321 with exactly the asked entries, in the asked order", async () => {
    const printer = await FakePrinter.start({ history: { entries } });
    const client = await connect(printer.url);
    try {
      client.socket.send(historyRequest(321, "e".repeat(32), { Id: ["job-a", "job-c"] }));
      const response = (await client.next()) as {
        Data: { Cmd: number; Data: { Ack: number; HistoryDetailList: { TaskId: string }[] } };
      };
      assert.equal(response.Data.Cmd, 321);
      assert.equal(response.Data.Data.Ack, 0);
      assert.deepEqual(response.Data.Data.HistoryDetailList, [entries[2], entries[0]]);
    } finally {
      client.socket.close();
      await printer.close();
    }
  });

  it("lets a silent reply for 320 win over the history", async () => {
    const printer = await FakePrinter.start({ history: { entries }, replies: { 320: "silent" } });
    const client = await connect(printer.url);
    try {
      client.socket.send(historyRequest(320, "f".repeat(32), {}));
      client.socket.send(request(0, "0".repeat(32)));
      const response = (await client.next()) as { Data: { Cmd: number } };
      assert.equal(response.Data.Cmd, 0);
      assert.equal(client.frames.length, 0);
      assert.deepEqual(printer.receivedCommands, [320, 0]);
    } finally {
      client.socket.close();
      await printer.close();
    }
  });
});

describe("fake thumbnails", () => {
  it("answers 200 with the given bytes and counts requests", async () => {
    const bytes = fakePng("job-a");
    const thumbnails = await FakeThumbnails.start({
      answer: (taskId) => (taskId === "job-a" ? { body: bytes } : undefined),
    });
    try {
      const url = thumbnails.urlFor("job-a");
      assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/board-resource\/history_image\/job-a\.png$/);
      const response = await fetch(url);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "image/png");
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
      const missing = await fetch(thumbnails.urlFor("job-z"));
      assert.equal(missing.status, 404);
      await missing.arrayBuffer();
      assert.equal(thumbnails.requests, 2);
      assert.equal(thumbnails.requestsFor.get("job-a"), 1);
    } finally {
      await thumbnails.close();
    }
  });
});
