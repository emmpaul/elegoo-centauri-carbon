// Stop slide (design D12): the thumb is dragged with the pointer, or moved with
// the keyboard, to the end of the track to send stop. Releasing early springs
// it back and sends nothing. The geometry and key rules are the pure functions
// in view.ts; this module only turns pointer and key events into thumb offsets
// and leaves the drawing to the page's render.
import { type SlideState, settleSlide, slideDrag, slideKey, slideMax, slideReleased } from "./view.js";

export interface StopSlideHooks {
  /** The thumb state the page renders from; this module updates it in place. */
  slide: SlideState;
  /** Whether stop is allowed now (the slide is not disabled). */
  enabled(): boolean;
  /** The slide state changed: render again. */
  changed(): void;
  /** The thumb reached the end: send stop with the confirmation flag. */
  stop(): void;
}

/** Wires the thumb on `track`; `thumb` is its `role=slider` button. */
export function attachStopSlide(track: HTMLElement, thumb: HTMLButtonElement, hooks: StopSlideHooks): void {
  const { slide } = hooks;
  let drag: { x0: number; pointer: number } | null = null;

  const measure = (): void => {
    if (track.clientWidth > 0) slide.max = slideMax(track.clientWidth);
  };
  const reset = (): void => {
    drag = null;
    slide.dragging = false;
    slide.x = 0;
    hooks.changed();
  };

  thumb.addEventListener("pointerdown", (event) => {
    if (!hooks.enabled()) return;
    measure();
    thumb.setPointerCapture(event.pointerId);
    drag = { x0: event.clientX, pointer: event.pointerId };
    slide.dragging = true;
    slide.x = 0;
    hooks.changed();
  });
  thumb.addEventListener("pointermove", (event) => {
    if (drag === null || event.pointerId !== drag.pointer) return;
    slide.x = slideDrag(0, event.clientX - drag.x0, slide.max);
    hooks.changed();
  });
  thumb.addEventListener("pointerup", (event) => {
    if (drag === null || event.pointerId !== drag.pointer) return;
    const done = slideReleased(slide.x, slide.max);
    reset();
    if (done && hooks.enabled()) hooks.stop();
  });
  thumb.addEventListener("pointercancel", reset);
  thumb.addEventListener("lostpointercapture", () => {
    if (drag !== null) reset();
  });

  // Keyboard progress is dropped when the thumb loses focus.
  thumb.addEventListener("blur", () => {
    if (drag === null && settleSlide(slide, hooks.enabled(), false)) hooks.changed();
  });

  thumb.addEventListener("keydown", (event) => {
    measure();
    const step = slideKey(event.key, slide.x, slide.max, hooks.enabled());
    if (step === null) return;
    event.preventDefault();
    slide.x = step.x;
    hooks.changed();
    if (step.send) hooks.stop();
  });
}
