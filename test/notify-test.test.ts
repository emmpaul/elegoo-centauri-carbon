import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { type Config, defaultConfig } from "../src/config.ts";
import { sendTestNotification } from "../src/notify-test.ts";
import type { Logger } from "../src/sdcp-client.ts";
import { FakeMjpegSource, fakeJpeg } from "./support/fake-mjpeg.ts";
import { FakeNtfy } from "./support/fake-ntfy.ts";
import { FakePrinter, loadFixture } from "./support/fake-printer.ts";

function recordingLogger(): Logger & { infos: string[] } {
  const infos: string[] = [];
  return { infos, info: (m) => infos.push(m), warn() {}, error() {} };
}

/** Whether `raw` is one whole part of the fake camera (`fakeJpeg(n)`). */
function isFakeJpegPart(raw: Buffer): boolean {
  const match = /frame-(\d+)/.exec(raw.toString("latin1"));
  return match !== null && raw.equals(fakeJpeg(Number(match[1])));
}

describe("sendTestNotification", () => {
  let printer: FakePrinter;
  let camera: FakeMjpegSource;
  let ntfy: FakeNtfy;

  beforeEach(async () => {
    printer = await FakePrinter.start();
    camera = await FakeMjpegSource.start();
    ntfy = await FakeNtfy.start();
  });

  afterEach(async () => {
    // The test command never sends a light command.
    assert.equal(printer.receivedCommands.includes(403), false, "no Cmd 403");
    await printer.close();
    await camera.close();
    await ntfy.close();
  });

  /** Pushes a status once the session connects, as the printer does: the session counts as online from it. */
  async function answerWithStatus(): Promise<void> {
    await printer.waitForClient();
    printer.replay(loadFixture("print-complete.json"), (frame) => frame.seq === 24);
  }

  function config(photos: boolean): Config {
    const c = defaultConfig();
    c.ntfy = { url: ntfy.url, topic: "t", photos, photoLight: true };
    return c;
  }

  it("uploads a Photo from the camera and reports it", async () => {
    const logger = recordingLogger();
    const sending = sendTestNotification({ config: config(true), printerUrl: printer.url, cameraUrl: camera.url, logger });
    await answerWithStatus();
    const delivered = await sending;
    assert.equal(delivered, true);
    assert.equal(ntfy.requests.length, 1);
    const [request] = ntfy.requests;
    assert.equal(request?.method, "PUT");
    assert.equal(request?.path, "/t");
    assert.equal(request?.headers.filename, "photo-test.jpg");
    assert.ok(isFakeJpegPart(request!.raw), "the body is one whole camera part");
    assert.ok(logger.infos.includes(`Test notification sent to ${ntfy.url}, topic t, with a photo.`), logger.infos.join("\n"));
    await camera.waitForNoStreams();
    // The fake sees the socket close a moment after the session stops.
    for (let i = 0; i < 100 && printer.clientCount > 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(printer.clientCount, 0, "the session was closed");
  });

  it("sends text only and reports the reason when the camera port is closed", async () => {
    const closedUrl = camera.url;
    await camera.close();
    const logger = recordingLogger();
    const sending = sendTestNotification({ config: config(true), printerUrl: printer.url, cameraUrl: closedUrl, logger });
    await answerWithStatus();
    const delivered = await sending;
    assert.equal(delivered, true);
    assert.equal(ntfy.requests.length, 1);
    assert.equal(ntfy.requests[0]?.method, "POST");
    assert.equal((ntfy.requests[0]?.json as { title: string }).title, "Test notification");
    const report = logger.infos.find((line) => line.startsWith("Test notification sent to"));
    assert.match(report ?? "", new RegExp(`^Test notification sent to ${ntfy.url}, topic t, without a photo: .*ECONNREFUSED.*\\.$`));
    camera = await FakeMjpegSource.start();
  });

  it("sends text only and never contacts the printer with photos off", async () => {
    const logger = recordingLogger();
    const delivered = await sendTestNotification({ config: config(false), printerUrl: printer.url, cameraUrl: camera.url, logger });
    assert.equal(delivered, true);
    assert.equal(ntfy.requests.length, 1);
    assert.equal(ntfy.requests[0]?.method, "POST");
    assert.ok(logger.infos.includes(`Test notification sent to ${ntfy.url}, topic t.`), logger.infos.join("\n"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(printer.received.length, 0, "the fake printer received no frame");
    assert.equal(camera.connections, 0);
  });
});
