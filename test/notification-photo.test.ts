import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { PHOTO_EVENTS, type PhotoResult, PhotoTaker } from "../src/notification-photo.ts";
import { type CommandResult, ControlRejectedError } from "../src/print-control.ts";
import { emptySnapshot, type StatusSnapshot } from "../src/status-store.ts";
import type { Logger } from "../src/sdcp-client.ts";

/** Lets pending promise callbacks run while timers are mocked. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** A frame source whose answers the test decides, one per `takeFrame` call. */
class StubCamera {
  readonly calls: { signal: AbortSignal; after?: Promise<unknown> }[] = [];
  private readonly pending: { resolve: (frame: Buffer) => void; reject: (error: Error) => void }[] = [];

  takeFrame(options: { signal: AbortSignal; after?: Promise<unknown> }): Promise<Buffer> {
    this.calls.push(options);
    return new Promise<Buffer>((resolve, reject) => this.pending.push({ resolve, reject }));
  }

  answer(index: number, frame: Buffer): void {
    this.pending[index]!.resolve(frame);
  }

  fail(index: number, error: Error): void {
    this.pending[index]!.reject(error);
  }
}

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);

describe("PhotoTaker without the light", () => {
  let camera: StubCamera;
  let taker: PhotoTaker;

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
    camera = new StubCamera();
    taker = new PhotoTaker({ camera, light: null });
  });

  afterEach(() => mock.timers.reset());

  it("resolves with the frame's bytes", async () => {
    const pending = taker.take();
    await settle();
    assert.equal(camera.calls.length, 1);
    assert.equal(camera.calls[0]!.after, undefined);
    camera.answer(0, JPEG);
    const result = await pending;
    assert.ok(result.jpeg !== null);
    assert.deepEqual(result.jpeg, JPEG);
  });

  it("gives up with 'photo timed out' at 5000 ms, and not before", async () => {
    let result: PhotoResult | undefined;
    const pending = taker.take().then((r) => (result = r));
    await settle();
    mock.timers.tick(4_999);
    await settle();
    assert.equal(result, undefined, "still waiting at 4.999 s");
    assert.equal(camera.calls[0]!.signal.aborted, false);

    mock.timers.tick(1);
    await pending;
    assert.deepEqual(result, { jpeg: null, reason: "photo timed out" });
    assert.equal(camera.calls[0]!.signal.aborted, true, "the frame source is told to stop");
  });

  it("reports the source's error as the reason", async () => {
    const pending = taker.take();
    await settle();
    camera.fail(0, new Error("camera answered HTTP 503"));
    assert.deepEqual(await pending, { jpeg: null, reason: "camera answered HTTP 503" });
  });

  it("starts a second take only after the first ends, with the time left of its own limit", async () => {
    const first = taker.take();
    const second = taker.take();
    await settle();
    assert.equal(camera.calls.length, 1, "the second waits");

    mock.timers.tick(3_000);
    camera.answer(0, JPEG);
    assert.deepEqual((await first).jpeg, JPEG);
    await settle();
    assert.equal(camera.calls.length, 2, "the second starts once the first ended");

    let result: PhotoResult | undefined;
    void second.then((r) => (result = r));
    mock.timers.tick(1_999);
    await settle();
    assert.equal(result, undefined, "still waiting at 4.999 s");
    mock.timers.tick(1);
    await settle();
    assert.deepEqual(result, { jpeg: null, reason: "photo timed out" }, "timed out at 5 s from its request, not 8 s");
  });

  it("measures a queued take's limit from its request", async () => {
    let first: PhotoResult | undefined;
    let second: PhotoResult | undefined;
    void taker.take().then((r) => (first = r));
    await settle();
    mock.timers.tick(1_000);
    void taker.take().then((r) => (second = r));
    await settle();
    assert.equal(camera.calls.length, 1);

    mock.timers.tick(4_000); // t = 5000
    await settle();
    assert.deepEqual(first, { jpeg: null, reason: "photo timed out" });
    assert.equal(second, undefined);
    assert.equal(camera.calls.length, 2, "the second's frame is asked for at 5000 ms");

    mock.timers.tick(999); // t = 5999
    await settle();
    assert.equal(second, undefined, "still waiting at 5.999 s");
    mock.timers.tick(1); // t = 6000
    await settle();
    assert.deepEqual(second, { jpeg: null, reason: "photo timed out" });
  });

  it("does not attempt a queued take whose time ran out while it waited", async () => {
    const results: PhotoResult[] = [];
    void taker.take().then((r) => results.push(r));
    void taker.take().then((r) => results.push(r));
    await settle();
    mock.timers.tick(5_000);
    await settle();
    assert.deepEqual(results, [
      { jpeg: null, reason: "photo timed out" },
      { jpeg: null, reason: "photo timed out" },
    ]);
    assert.equal(camera.calls.length, 1, "the stalled source saw one call");
  });

  it("takes Photos for finished, failed, stopped, and paused only", () => {
    assert.deepEqual([...PHOTO_EVENTS].sort(), ["failed", "finished", "paused", "stopped"]);
  });
});

type Light = StatusSnapshot["light"];

/** A status store reduced to the light: `show()` emits a change. */
class StubStore extends EventEmitter<{ change: [StatusSnapshot] }> {
  private light: Light;
  constructor(light: Light) {
    super();
    this.light = light;
  }
  get snapshot(): StatusSnapshot {
    return { ...emptySnapshot("online"), light: this.light };
  }
  show(light: Light): void {
    this.light = light;
    this.emit("change", this.snapshot);
  }
}

/** A PrintControl reduced to the light: records commands, counts the sent ones. */
class StubControl {
  readonly sent: boolean[] = [];
  lightCommands = 0;
  /** Refuse every command, as the guard does offline or with LightStatus unknown. */
  refuse = false;
  /** Refuse the commands after this many were sent. */
  refuseAfter = Infinity;
  /** The printer's answer to each sent command, in order; a command past the end is never answered. */
  results: CommandResult[] = [];

  setLight(on: boolean): Promise<CommandResult> {
    if (this.refuse || this.sent.length >= this.refuseAfter) {
      return Promise.reject(new ControlRejectedError("light", "not-allowed"));
    }
    const result = this.results[this.sent.length];
    this.sent.push(on);
    this.lightCommands++;
    if (result !== undefined) return Promise.resolve(result);
    // Never answers: the Photo light must not wait for the response.
    return new Promise<CommandResult>(() => {});
  }
}

describe("PhotoTaker with the Photo light", () => {
  let camera: StubCamera;
  let control: StubControl;
  let warnings: string[];
  let logger: Logger;

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
    camera = new StubCamera();
    control = new StubControl();
    warnings = [];
    logger = { info: () => {}, warn: (message) => warnings.push(message), error: (message) => warnings.push(message) };
  });

  afterEach(() => mock.timers.reset());

  function takerWith(store: StubStore): PhotoTaker {
    return new PhotoTaker({ camera, light: { state: store, control }, logger });
  }

  /** True once the frame source's `after` has settled. */
  async function armed(index = 0): Promise<boolean> {
    let done = false;
    void camera.calls[index]!.after!.then(() => (done = true));
    await settle();
    return done;
  }

  it("turns the light on, arms the frame on the 'on' change, and turns it off after", async () => {
    const store = new StubStore("off");
    const pending = takerWith(store).take();
    await settle();
    assert.deepEqual(control.sent, [true]);
    assert.equal(camera.calls.length, 1, "the camera opens in parallel");
    assert.equal(await armed(), false, "not armed before the light shows on");

    store.show("on");
    assert.equal(await armed(), true);
    camera.answer(0, JPEG);
    assert.deepEqual((await pending).jpeg, JPEG);
    assert.deepEqual(control.sent, [true, false]);
    assert.equal(store.listenerCount("change"), 0, "the change listener is removed after the take");
  });

  it("arms the frame at 3000 ms without a change, and the result arrives before 5000 ms", async () => {
    const store = new StubStore("off");
    let result: PhotoResult | undefined;
    const pending = takerWith(store)
      .take()
      .then((r) => (result = r));
    await settle();
    mock.timers.tick(2_999);
    assert.equal(await armed(), false);
    mock.timers.tick(1);
    assert.equal(await armed(), true);

    mock.timers.tick(500);
    camera.answer(0, JPEG);
    await pending;
    assert.deepEqual(result?.jpeg, JPEG);
    assert.equal(store.listenerCount("change"), 0, "the change listener is removed after the take");
  });

  for (const light of ["on", "unknown"] as const) {
    it(`sends no light command when the light is ${light}`, async () => {
      const pending = takerWith(new StubStore(light)).take();
      await settle();
      assert.equal(camera.calls[0]!.after, undefined);
      camera.answer(0, JPEG);
      assert.deepEqual((await pending).jpeg, JPEG);
      assert.deepEqual(control.sent, []);
    });
  }

  it("takes the Photo as it is when the guard refuses the command", async () => {
    control.refuse = true;
    const pending = takerWith(new StubStore("off")).take();
    await settle();
    assert.equal(camera.calls[0]!.after, undefined, "no wait for a light that was never asked for");
    camera.answer(0, JPEG);
    assert.deepEqual((await pending).jpeg, JPEG);
    assert.deepEqual(control.sent, []);
    assert.deepEqual(warnings, []);
  });

  it("leaves the light on when someone else sent a light command meanwhile", async () => {
    const store = new StubStore("off");
    const pending = takerWith(store).take();
    await settle();
    control.lightCommands++; // the dashboard's command
    store.show("on");
    await settle();
    camera.answer(0, JPEG);
    await pending;
    assert.deepEqual(control.sent, [true]);
  });

  it("sends no off command when a change showed the light off after on", async () => {
    const store = new StubStore("off");
    const pending = takerWith(store).take();
    await settle();
    store.show("on");
    store.show("off");
    store.show("on");
    await settle();
    camera.answer(0, JPEG);
    await pending;
    assert.deepEqual(control.sent, [true]);
  });

  it("attempts the off command when the light is not reported on at the restore", async () => {
    const store = new StubStore("off");
    const pending = takerWith(store).take();
    await settle();
    store.show("on");
    store.show("unknown"); // the printer stopped reporting the light
    await settle();
    camera.answer(0, JPEG);
    assert.deepEqual((await pending).jpeg, JPEG);
    await settle();
    assert.deepEqual(control.sent, [true, false]);
    assert.equal(store.listenerCount("change"), 0);
  });

  it("turns the light off when the push showing it on arrives only after the Photo", async () => {
    const store = new StubStore("off");
    let result: PhotoResult | undefined;
    const pending = takerWith(store)
      .take()
      .then((r) => (result = r));
    await settle();
    mock.timers.tick(3_000);
    assert.equal(await armed(), true);
    camera.answer(0, JPEG);
    await pending;
    assert.deepEqual(result?.jpeg, JPEG);
    store.show("on"); // the late push
    await settle();
    assert.deepEqual(control.sent, [true, false]);
  });

  it("turns the light off after a Photo armed at 3000 ms with no change at all", async () => {
    const store = new StubStore("off");
    const pending = takerWith(store).take();
    await settle();
    mock.timers.tick(3_000);
    assert.equal(await armed(), true);
    camera.answer(0, JPEG);
    assert.deepEqual((await pending).jpeg, JPEG);
    await settle();
    assert.deepEqual(control.sent, [true, false]);
    assert.equal(store.listenerCount("change"), 0);
  });

  it("sends no off command when someone else sent a light command and no change came", async () => {
    const store = new StubStore("off");
    const pending = takerWith(store).take();
    await settle();
    control.lightCommands++; // the dashboard's command
    mock.timers.tick(3_000);
    await settle();
    camera.answer(0, JPEG);
    await pending;
    await settle();
    assert.deepEqual(control.sent, [true]);
  });

  it("arms a queued take with 1000 ms left at once, without the 3000 ms light wait", async () => {
    const store = new StubStore("off");
    const taker = takerWith(store);
    void taker.take();
    await settle();
    mock.timers.tick(1_000);
    let second: PhotoResult | undefined;
    void taker.take().then((r) => (second = r));
    await settle();
    mock.timers.tick(4_000); // t = 5000: the first times out, the second has 1000 ms left
    await settle();
    assert.equal(camera.calls.length, 2);
    assert.deepEqual(control.sent, [true, false, true], "the second still turns the light on");
    assert.equal(await armed(1), true, "armed at once");
    camera.answer(1, JPEG);
    await settle();
    assert.deepEqual(second?.jpeg, JPEG);
  });

  it("shortens the light wait of a queued take with 3500 ms left to 1500 ms, keeping 2000 ms for the frame", async () => {
    const store = new StubStore("off");
    const taker = takerWith(store);
    const first = taker.take();
    await settle();
    mock.timers.tick(1_500);
    void taker.take(); // its limit ends at 6500 ms
    await settle();
    mock.timers.tick(1_500); // t = 3000: the first ends, the second has 3500 ms left
    camera.answer(0, JPEG);
    await first;
    await settle();
    assert.equal(camera.calls.length, 2);
    assert.deepEqual(control.sent, [true, false, true], "the second turns the light on");
    mock.timers.tick(1_499);
    assert.equal(await armed(1), false, "not armed at 1499 ms");
    mock.timers.tick(1);
    assert.equal(await armed(1), true, "armed at 1500 ms, leaving 2000 ms for the frame");
  });

  it("warns when the printer answers the light commands with a failure or not at all", async () => {
    control.results = [
      { action: "light", outcome: "failed", code: 7 },
      { action: "light", outcome: "timeout" },
    ];
    const store = new StubStore("off");
    const pending = takerWith(store).take();
    await settle();
    store.show("on");
    await settle();
    camera.answer(0, JPEG);
    assert.deepEqual((await pending).jpeg, JPEG);
    await settle();
    assert.deepEqual(control.sent, [true, false]);
    assert.deepEqual(warnings, [
      "photo: turning the light on failed with code 7",
      "photo: turning the light off got no response",
    ]);
  });

  it("does not warn when the printer acknowledges the light commands", async () => {
    control.results = [
      { action: "light", outcome: "acknowledged" },
      { action: "light", outcome: "acknowledged" },
    ];
    const store = new StubStore("off");
    const pending = takerWith(store).take();
    await settle();
    store.show("on");
    await settle();
    camera.answer(0, JPEG);
    await pending;
    await settle();
    assert.deepEqual(control.sent, [true, false]);
    assert.deepEqual(warnings, []);
  });

  it("on close, waits for the running take's light restore and skips a queued take", async () => {
    const store = new StubStore("off");
    const taker = takerWith(store);
    const first = taker.take();
    const second = taker.take();
    await settle();
    let closed = false;
    const closing = taker.close().then(() => (closed = true));
    await settle();
    assert.equal(closed, false, "the running take has not ended");
    camera.fail(0, new Error("camera proxy closed")); // the service closes the camera
    await closing;
    assert.deepEqual(control.sent, [true, false], "the off command went out before close resolved");
    assert.deepEqual(await first, { jpeg: null, reason: "camera proxy closed" });
    assert.deepEqual(await second, { jpeg: null, reason: "service is shutting down" });
    assert.equal(camera.calls.length, 1, "the queued take never asked for a frame");
  });

  it("on close, gives up waiting for a take that does not end after 1000 ms", async () => {
    const taker = takerWith(new StubStore("off"));
    void taker.take();
    await settle();
    let closed = false;
    void taker.close().then(() => (closed = true));
    mock.timers.tick(999);
    await settle();
    assert.equal(closed, false);
    mock.timers.tick(1);
    await settle();
    assert.equal(closed, true);
  });

  it("sends no command when the Photo light is off", async () => {
    const pending = new PhotoTaker({ camera, light: null, logger }).take();
    await settle();
    camera.answer(0, JPEG);
    assert.deepEqual((await pending).jpeg, JPEG);
    assert.deepEqual(control.sent, []);
  });

  it("logs a warning when the restore is refused, and the take still resolves", async () => {
    control.refuseAfter = 1;
    const store = new StubStore("off");
    const pending = takerWith(store).take();
    await settle();
    store.show("on");
    await settle();
    camera.answer(0, JPEG);
    assert.deepEqual((await pending).jpeg, JPEG);
    await settle();
    assert.deepEqual(control.sent, [true]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /light/);
    assert.match(warnings[0]!, /not allowed/);
  });
});
