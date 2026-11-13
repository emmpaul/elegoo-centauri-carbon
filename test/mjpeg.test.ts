import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { delimiterOf, MjpegParser } from "../web/mjpeg.ts";
import { FAKE_BOUNDARY, fakeJpeg } from "./support/fake-mjpeg.ts";

const enc = (text: string) => new TextEncoder().encode(text);

function part(body: Uint8Array, withLength: boolean): Uint8Array {
  const head = `--${FAKE_BOUNDARY}\r\nContent-Type: image/jpeg\r\n${withLength ? `Content-Length: ${body.length}\r\n` : ""}\r\n`;
  return Buffer.concat([enc(head), body, enc("\r\n")]);
}

/** Feeds `bytes` in chunks of `size` and collects every frame. */
function feed(parser: MjpegParser, bytes: Uint8Array, size: number): Uint8Array[] {
  const frames: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) frames.push(...parser.push(bytes.subarray(i, i + size)));
  return frames;
}

describe("MjpegParser", () => {
  const bodies = [fakeJpeg(0), fakeJpeg(1, 40), fakeJpeg(2)];

  for (const withLength of [true, false]) {
    for (const size of [1, 7, 4096]) {
      it(`splits parts ${withLength ? "with" : "without"} Content-Length, in chunks of ${size} bytes`, () => {
        const stream = Buffer.concat([...bodies.map((body) => part(body, withLength)), enc(`--${FAKE_BOUNDARY}\r\n`)]);
        const frames = feed(new MjpegParser(delimiterOf(`multipart/x-mixed-replace; boundary=${FAKE_BOUNDARY}`)), stream, size);
        assert.deepEqual(frames.map((f) => Buffer.from(f)), bodies);
      });
    }
  }

  it("holds a part until its Content-Length bytes have arrived", () => {
    const parser = new MjpegParser(delimiterOf(`multipart/x-mixed-replace; boundary=${FAKE_BOUNDARY}`));
    const bytes = part(bodies[1] as Buffer, true);
    assert.deepEqual(parser.push(bytes.subarray(0, bytes.length - 10)), []);
    assert.deepEqual(parser.push(bytes.subarray(bytes.length - 10)).map((f) => Buffer.from(f)), [bodies[1]]);
  });

  it("falls back to JPEG markers without a boundary", () => {
    const stream = Buffer.concat([enc("junk"), ...bodies, enc("tail")]);
    assert.deepEqual(feed(new MjpegParser(null), stream, 3).map((f) => Buffer.from(f)), bodies);
  });

  it("reads quoted and dash-prefixed boundaries", () => {
    assert.deepEqual(delimiterOf('multipart/x-mixed-replace; boundary="abc"'), enc("--abc"));
    assert.deepEqual(delimiterOf("multipart/x-mixed-replace;boundary=--abc"), enc("--abc"));
    assert.equal(delimiterOf("image/jpeg"), null);
    assert.equal(delimiterOf(null), null);
  });
});
