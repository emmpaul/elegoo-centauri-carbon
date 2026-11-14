// The dashboard's command flow (web/commands.ts): one command at a time from
// pending to its outcome, the 2.6 s clear of an acknowledgement, and the
// failures the service or the network give.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import type { StatusSnapshot } from "../src/status-store.ts";
import "./support/web-modules.ts";

const { COMMAND_ABORT_MS, Commands, reasonOf } = await import("../web/commands.ts");
const { ACK_CLEAR_MS } = await import("../web/view.ts");

interface Sent {
  path: string;
  body: unknown;
}

/** A printing printer's snapshot, with `patch` on top. */
function snap(patch: Partial<StatusSnapshot> = {}): StatusSnapshot {
  return {
    connection: "online",
    printerName: "Centauri Carbon",
    machineState: { name: "printing", code: 1 },
    printState: { name: "printing", code: 13 },
    taskId: null,
    fileName: "benchy.gcode",
    progress: 42,
    layer: { current: 210, total: 500 },
    elapsed: 3600,
    remaining: 4900,
    temperatures: { nozzle: { current: 210, target: 210 }, bed: { current: 60, target: 60 }, chamber: { current: 30, target: 0 } },
    light: "on",
    errorCode: 0,
    updatedAt: 0,
    ...patch,
  } as StatusSnapshot;
}

/** A host whose fetch answers from `answer` and records every request; the page state is in `page`. */
function host(answer: (body: unknown, signal: AbortSignal) => Promise<Response>) {
  const sent: Sent[] = [];
  const counts = { changed: 0, unauthorized: 0 };
  const page = { snapshot: snap() as StatusSnapshot | null, streamOpen: true };
  return {
    sent,
    counts,
    page,
    snapshot: () => page.snapshot,
    streamOpen: () => page.streamOpen,
    fetch(path: string, init: RequestInit): Promise<Response> {
      const body = JSON.parse(String(init.body)) as unknown;
      sent.push({ path, body });
      return answer(body, init.signal as AbortSignal);
    },
    changed: () => void counts.changed++,
    unauthorized: () => void counts.unauthorized++,
  };
}

const json = (status: number, payload: unknown): Promise<Response> => Promise.resolve(Response.json(payload, { status }));

describe("dashboard commands", () => {
  beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
  afterEach(() => mock.timers.reset());

  it("goes pending, then acknowledged, and clears the acknowledgement after 2.6 s", async () => {
    const h = host(() => json(200, { outcome: "acknowledged" }));
    const commands = new Commands(h);
    const sending = commands.send("pause", { action: "pause" });
    assert.deepEqual(commands.state, { action: "pause", status: "pending" });
    await sending;
    assert.deepEqual(h.sent, [{ path: "/api/command", body: { action: "pause" } }]);
    assert.deepEqual(commands.state, { action: "pause", status: "ack" });
    mock.timers.tick(ACK_CLEAR_MS - 1);
    assert.deepEqual(commands.state, { action: "pause", status: "ack" });
    mock.timers.tick(1);
    assert.equal(commands.state, null);
    assert.equal(h.counts.changed, 3, "pending, ack, cleared");
  });

  it("ignores a second command while one is in flight", async () => {
    let answer: (response: Response) => void = () => undefined;
    const h = host(() => new Promise((resolve) => (answer = resolve)));
    const commands = new Commands(h);
    const first = commands.send("pause", { action: "pause" });
    await commands.send("light", { action: "light", on: false });
    assert.equal(h.sent.length, 1);
    answer(Response.json({ outcome: "acknowledged" }));
    await first;
  });

  it("maps the printer's failure and timeout outcomes", async () => {
    const failed = new Commands(host(() => json(200, { outcome: "failed", code: 2 })));
    await failed.send("pause", { action: "pause" });
    assert.deepEqual(failed.state, { action: "pause", status: "failed", code: 2 });
    const timedOut = new Commands(host(() => json(200, { outcome: "timeout" })));
    await timedOut.send("pause", { action: "pause" });
    assert.deepEqual(timedOut.state, { action: "pause", status: "timeout" });
  });

  it("shows a command the service rejected as failed with its message as the reason", async () => {
    const h = host(() => json(409, { error: { code: "not-allowed", message: "pause is not allowed while paused" } }));
    const commands = new Commands(h);
    await commands.send("pause", { action: "pause" });
    assert.deepEqual(commands.state, { action: "pause", status: "failed", code: null, reason: "Pause is not allowed while paused." });
    assert.equal(h.counts.unauthorized, 0);
  });

  it("checks the token again after a 401", async () => {
    const h = host(() => json(401, { error: { code: "unauthorized", message: "missing or wrong access token" } }));
    const commands = new Commands(h);
    await commands.send("pause", { action: "pause" });
    assert.equal(commands.state?.reason, "Missing or wrong access token.");
    assert.equal(h.counts.unauthorized, 1);
  });

  it("names the HTTP status when the answer has no message, and an unreachable service", async () => {
    assert.equal(reasonOf(null, 502), "The service answered HTTP 502.");
    assert.equal(reasonOf({ error: { message: "" } }, 500), "The service answered HTTP 500.");
    const down = new Commands(host(() => Promise.reject(new TypeError("fetch failed"))));
    await down.send("pause", { action: "pause" });
    assert.deepEqual(down.state, { action: "pause", status: "failed", code: null, reason: "The service can’t be reached." });
  });

  it("aborts a request with no answer after 15 s and shows it as timed out", async () => {
    const h = host((_body, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason))));
    const commands = new Commands(h);
    const sending = commands.send("pause", { action: "pause" });
    mock.timers.tick(COMMAND_ABORT_MS);
    await sending;
    assert.deepEqual(commands.state, { action: "pause", status: "timeout" });
  });

  it("dismiss clears the message", async () => {
    const commands = new Commands(host(() => json(200, { outcome: "failed", code: 2 })));
    await commands.send("pause", { action: "pause" });
    commands.dismiss();
    assert.equal(commands.state, null);
  });

  it("Retry re-sends the last request only while the service would accept it", async () => {
    const h = host(() => json(200, { outcome: "timeout" }));
    const commands = new Commands(h);
    await commands.send("pause", { action: "pause" });
    // The printer paused anyway: the service would answer 409.
    h.page.snapshot = snap({ printState: { name: "paused", code: 6 }, machineState: { name: "printing", code: 1 } });
    await commands.retry();
    h.page.snapshot = snap();
    h.page.streamOpen = false;
    await commands.retry();
    h.page.streamOpen = true;
    h.page.snapshot = snap({ connection: "offline" });
    await commands.retry();
    assert.equal(h.sent.length, 1, "nothing re-sent while pause is not accepted");
    assert.deepEqual(commands.state, { action: "pause", status: "timeout" }, "the message stays for ×");
    h.page.snapshot = snap();
    await commands.retry();
    assert.deepEqual(h.sent.map((s) => s.body), [{ action: "pause" }, { action: "pause" }]);
  });

  it("Retry never re-sends stop", async () => {
    const h = host(() => json(200, { outcome: "timeout" }));
    const commands = new Commands(h);
    await commands.stop();
    await commands.retry();
    assert.equal(h.sent.length, 1);
  });
});
