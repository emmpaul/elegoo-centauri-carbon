// The stop slide's event wiring (web/stop-slide.ts) on stand-in elements:
// only a drag to the end of the track, or the fourth → press, sends stop, and
// it goes out with the confirmation flag; an early release sends nothing, and
// keyboard progress is dropped when the thumb loses focus.
/// <reference lib="dom" />
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import "./support/web-modules.ts";

const { attachStopSlide } = await import("../web/stop-slide.ts");
const { Commands } = await import("../web/commands.ts");
const { slideMax } = await import("../web/view.ts");

/** The thumb: an event target with pointer capture. */
class Thumb extends EventTarget {
  setPointerCapture(): void {}
}

const pointer = (type: string, clientX: number, pointerId = 1): Event => Object.assign(new Event(type), { clientX, pointerId });
const key = (name: string): Event => Object.assign(new Event("keydown", { cancelable: true }), { key: name });

/** A slide on a 328 px track wired to real commands over a recording fetch. */
function setUp(enabled = true) {
  const bodies: unknown[] = [];
  const slide = { x: 0, dragging: false, max: 0 };
  let changed = 0;
  const commands = new Commands({
    fetch: (_path, init) => {
      bodies.push(JSON.parse(String(init.body)));
      return Promise.resolve(Response.json({ outcome: "acknowledged" }));
    },
    snapshot: () => null,
    streamOpen: () => true,
    changed: () => undefined,
    unauthorized: () => undefined,
  });
  const thumb = new Thumb();
  const track = { clientWidth: 328 };
  attachStopSlide(track as unknown as HTMLElement, thumb as unknown as HTMLButtonElement, {
    slide,
    enabled: () => enabled,
    changed: () => void changed++,
    stop: () => void commands.stop(),
  });
  return { bodies, slide, thumb, changes: () => changed };
}

const MAX = slideMax(328);

describe("stop slide wiring", () => {
  it("a drag to the end sends stop with confirm: true and springs back", () => {
    const { bodies, slide, thumb } = setUp();
    thumb.dispatchEvent(pointer("pointerdown", 10));
    assert.equal(slide.dragging, true);
    thumb.dispatchEvent(pointer("pointermove", 10 + MAX + 40));
    assert.equal(slide.x, MAX, "clamped to the track");
    thumb.dispatchEvent(pointer("pointerup", 10 + MAX + 40));
    assert.deepEqual(bodies, [{ action: "stop", confirm: true }]);
    assert.deepEqual([slide.x, slide.dragging], [0, false]);
  });

  it("an early release, a cancel, or a lost capture sends nothing", () => {
    const { bodies, slide, thumb } = setUp();
    thumb.dispatchEvent(pointer("pointerdown", 10));
    thumb.dispatchEvent(pointer("pointermove", 10 + MAX - 10));
    thumb.dispatchEvent(pointer("pointerup", 10 + MAX - 10));
    assert.equal(slide.x, 0, "springs back");
    for (const end of ["pointercancel", "lostpointercapture"]) {
      thumb.dispatchEvent(pointer("pointerdown", 10));
      thumb.dispatchEvent(pointer("pointermove", 10 + MAX));
      thumb.dispatchEvent(pointer(end, 10 + MAX));
      assert.equal(slide.x, 0, end);
      thumb.dispatchEvent(pointer("pointerup", 10 + MAX));
    }
    assert.deepEqual(bodies, []);
  });

  it("another pointer's moves and release do not count", () => {
    const { bodies, slide, thumb } = setUp();
    thumb.dispatchEvent(pointer("pointerdown", 10, 1));
    thumb.dispatchEvent(pointer("pointermove", 10 + MAX, 2));
    thumb.dispatchEvent(pointer("pointerup", 10 + MAX, 2));
    assert.equal(slide.x, 0);
    assert.deepEqual(bodies, []);
  });

  it("a disabled slide ignores the pointer and the keyboard", () => {
    const { bodies, slide, thumb } = setUp(false);
    thumb.dispatchEvent(pointer("pointerdown", 10));
    thumb.dispatchEvent(pointer("pointermove", 10 + MAX));
    thumb.dispatchEvent(pointer("pointerup", 10 + MAX));
    for (let i = 0; i < 4; i++) thumb.dispatchEvent(key("ArrowRight"));
    assert.equal(slide.x, 0);
    assert.deepEqual(bodies, []);
  });

  it("the fourth → press sends stop with confirm: true; fewer send nothing", () => {
    const { bodies, slide, thumb } = setUp();
    for (let i = 0; i < 3; i++) thumb.dispatchEvent(key("ArrowRight"));
    assert.equal(slide.x, (MAX * 3) / 4);
    assert.deepEqual(bodies, []);
    const press = key("ArrowRight");
    thumb.dispatchEvent(press);
    assert.equal(press.defaultPrevented, true);
    assert.deepEqual(bodies, [{ action: "stop", confirm: true }]);
    assert.equal(slide.x, 0);
  });

  it("drops keyboard progress when the thumb loses focus", () => {
    const { bodies, slide, thumb, changes } = setUp();
    thumb.dispatchEvent(key("ArrowRight"));
    thumb.dispatchEvent(key("ArrowRight"));
    const before = changes();
    thumb.dispatchEvent(new Event("blur"));
    assert.equal(slide.x, 0);
    assert.equal(changes(), before + 1, "the page renders the reset");
    // Two more presses after focus returns do not reach the end.
    thumb.dispatchEvent(key("ArrowRight"));
    thumb.dispatchEvent(key("ArrowRight"));
    assert.deepEqual(bodies, []);
  });
});
