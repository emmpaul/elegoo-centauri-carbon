import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { PHOTO_EVENTS, type PhotoResult, PhotoTaker } from "../src/notification-photo.ts";

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
    mock.timers.enable({ apis: ["setTimeout"] });
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

  it("starts a second take only after the first ends, with its own time limit", async () => {
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
    mock.timers.tick(4_999);
    await settle();
    assert.equal(result, undefined, "the second's limit starts when it starts");
    mock.timers.tick(1);
    await settle();
    assert.deepEqual(result, { jpeg: null, reason: "photo timed out" });
  });

  it("takes Photos for finished, failed, stopped, and paused only", () => {
    assert.deepEqual([...PHOTO_EVENTS].sort(), ["failed", "finished", "paused", "stopped"]);
  });
});
