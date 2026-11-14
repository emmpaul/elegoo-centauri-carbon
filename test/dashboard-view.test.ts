// The dashboard's view model (web/view.ts) against the design references:
// every expected string is the one PrinterScreen.dc.html renders for the same
// snapshot (docs/design/reference/, states a1–a8, b1, and c1–c5).
process.env.TZ = "UTC";

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type ControlAction, isAllowed } from "../src/control-rules.ts";
import type { PrintStateName, StatusSnapshot } from "../src/status-store.ts";
import {
  type CommandState,
  type PageState,
  type StatusPageState,
  type StatusView,
  clock,
  dashboardView,
  duration,
  isLive,
  settleSlide,
  slideDrag,
  slideKey,
  slideMax,
  slideReleased,
  statusView,
  tokenView,
} from "../web/view.ts";

/** The references' "now": 2026-11-13 21:20:00 (UTC here). */
const NOW = Date.UTC(2026, 10, 13, 21, 20, 0);
const LIVE: StatusPageState = { streamOpen: true, messageShown: false };

type Patch = Partial<Omit<StatusSnapshot, "printState" | "machineState">> & {
  printState?: { name: string; code?: number | null };
  machineState?: { name: string; code: number | null };
};

/** The component's base preset as a service snapshot, with a variant's fields on top. */
function snapshot(patch: Patch = {}): StatusSnapshot {
  const base = {
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
    temperatures: { nozzle: { current: 210.1, target: 210 }, bed: { current: 59.9, target: 60 }, chamber: { current: 30.5, target: 0 } },
    light: "on",
    errorCode: 0,
    updatedAt: NOW - 3000,
  };
  return { ...base, ...patch, printState: { ...base.printState, ...(patch.printState ?? {}) } } as StatusSnapshot;
}

const PRESETS = {
  a1: snapshot(),
  a2: snapshot({
    printState: { name: "preparing" }, progress: 0, layer: { current: 0, total: 500 }, elapsed: 40, remaining: 8460,
    temperatures: { nozzle: { current: 141.6, target: 210 }, bed: { current: 52.3, target: 60 }, chamber: { current: 27.0, target: 0 } },
  }),
  a3: snapshot({ printState: { name: "pausing" } }),
  a4: snapshot({ printState: { name: "paused" }, machineState: { name: "paused", code: 2 }, elapsed: 3720 }),
  a5: snapshot({
    printState: { name: "completed" }, machineState: { name: "idle", code: 0 }, fileName: null, progress: 0, layer: { current: 0, total: 0 }, elapsed: 8520, remaining: 0,
    temperatures: { nozzle: { current: 62.4, target: 0 }, bed: { current: 44.8, target: 0 }, chamber: { current: 33.1, target: 0 } },
  }),
  a6: snapshot({
    printState: { name: "idle" }, machineState: { name: "idle", code: 0 }, fileName: null, progress: 0, layer: { current: 0, total: 0 }, elapsed: 0, remaining: 0, light: "off",
    temperatures: { nozzle: { current: 26.3, target: 0 }, bed: { current: 24.9, target: 0 }, chamber: { current: 23.8, target: 0 } },
  }),
  a7: snapshot({
    printState: { name: "paused" }, machineState: { name: "paused", code: 2 }, errorCode: 45, progress: 67, layer: { current: 335, total: 500 }, elapsed: 6120, remaining: 2950,
    temperatures: { nozzle: { current: 209.9, target: 210 }, bed: { current: 60.0, target: 60 }, chamber: { current: 31.2, target: 0 } },
  }),
  a8: snapshot({ printState: { name: "unknown", code: 7 } }),
  b1: snapshot({
    connection: "offline", updatedAt: NOW - 6 * 60000 - 20000, progress: 38, layer: { current: 190, total: 500 }, elapsed: 3240, remaining: 5300,
    temperatures: { nozzle: { current: 210.0, target: 210 }, bed: { current: 60.0, target: 60 }, chamber: { current: 30.2, target: 0 } },
  }),
};

const rows = (view: StatusView): string[][] => view.rows.map((r) => [r.key, r.value, r.target]);
const TEMPS_A1 = [["Nozzle", "210.1°", "/ 210°"], ["Bed", "59.9°", "/ 60°"], ["Chamber", "30.5°", "—"]];

describe("statusView", () => {
  it("a1 printing mid-job", () => {
    const v = statusView(PRESETS.a1, LIVE, NOW);
    assert.equal(v.printerName, "Centauri Carbon");
    assert.equal(v.online, true);
    assert.equal(v.banner, null);
    assert.equal(v.stateLabel, "Printing");
    assert.equal(v.tone, "ok");
    assert.equal(v.glyph, "run");
    assert.equal(v.fileName, "benchy.gcode");
    assert.equal(v.updateClock, "21:19:57");
    assert.deepEqual(v.headline, { big: "1h 22m", pct: "42%", sub: "left · done 22:41" });
    assert.deepEqual(v.ticks, { pct: 42, width: "42%", glow: true });
    assert.equal(v.error, null);
    assert.equal(v.note, null);
    assert.deepEqual(rows(v), [["Layer", "210", "/ 500"], ["Elapsed", "1h 00m", ""], ...TEMPS_A1]);
  });

  it("a2 preparing: info tone, heating sub-line, far targets with an arrow", () => {
    const v = statusView(PRESETS.a2, LIVE, NOW);
    assert.equal(v.stateLabel, "Preparing");
    assert.equal(v.tone, "info");
    assert.equal(v.glyph, "busy");
    assert.deepEqual(v.headline, { big: "2h 21m", pct: "0%", sub: "estimated · heating up" });
    assert.deepEqual(v.ticks, { pct: 0, width: "0%", glow: true });
    assert.deepEqual(rows(v), [
      ["Layer", "0", "/ 500"], ["Elapsed", "1m", ""], ["Nozzle", "141.6°", "→ 210°"], ["Bed", "52.3°", "→ 60°"], ["Chamber", "27.0°", "—"],
    ]);
  });

  it("a3 pausing", () => {
    const v = statusView(PRESETS.a3, LIVE, NOW);
    assert.equal(v.stateLabel, "Pausing…");
    assert.equal(v.tone, "warn");
    assert.equal(v.glyph, "busy");
    assert.deepEqual(v.headline, { big: "1h 22m", pct: "42%", sub: "left · pausing" });
  });

  it("a4 paused", () => {
    const v = statusView(PRESETS.a4, LIVE, NOW);
    assert.equal(v.stateLabel, "Paused");
    assert.equal(v.tone, "warn");
    assert.equal(v.glyph, "pause");
    assert.deepEqual(v.headline, { big: "1h 22m", pct: "42%", sub: "left · timer held" });
    assert.deepEqual(rows(v), [["Layer", "210", "/ 500"], ["Elapsed", "1h 02m", ""], ...TEMPS_A1]);
  });

  it("a5 completed with the file name cleared", () => {
    const v = statusView(PRESETS.a5, LIVE, NOW);
    assert.equal(v.stateLabel, "Complete");
    assert.equal(v.tone, "ok");
    assert.equal(v.glyph, "done");
    assert.equal(v.fileName, null);
    assert.deepEqual(v.headline, { big: "2h 22m", pct: "Done", sub: "total print time · bed 45°, let it cool" });
    assert.deepEqual(v.ticks, { pct: 100, width: "100%", glow: true });
    assert.deepEqual(rows(v), [["Nozzle", "62.4°", "off"], ["Bed", "44.8°", "off"], ["Chamber", "33.1°", "—"]]);
  });

  it("a6 idle", () => {
    const v = statusView(PRESETS.a6, LIVE, NOW);
    assert.equal(v.stateLabel, "Idle");
    assert.equal(v.tone, "neutral");
    assert.equal(v.glyph, "idle");
    assert.equal(v.fileName, null);
    assert.deepEqual(v.headline, { big: "Ready", pct: "", sub: "No job. Start one from the printer or slicer." });
    assert.deepEqual(v.ticks, { pct: 0, width: "0%", glow: false });
    assert.deepEqual(rows(v), [["Nozzle", "26.3°", "off"], ["Bed", "24.9°", "off"], ["Chamber", "23.8°", "—"]]);
  });

  it("a7 print error 45: alert, no Elapsed row", () => {
    const v = statusView(PRESETS.a7, LIVE, NOW);
    assert.equal(v.stateLabel, "Paused");
    assert.deepEqual(v.error, { title: "Error 45 · filament low", text: "Load filament, then resume." });
    assert.deepEqual(v.headline, { big: "49m", pct: "67%", sub: "left · timer held" });
    assert.deepEqual(rows(v), [["Layer", "335", "/ 500"], ["Nozzle", "209.9°", "/ 210°"], ["Bed", "60.0°", "/ 60°"], ["Chamber", "31.2°", "—"]]);
  });

  it("any other error code gets the generic text", () => {
    const v = statusView(snapshot({ errorCode: 12 }), LIVE, NOW);
    assert.deepEqual(v.error, { title: "Error 12", text: "Check the printer screen for details." });
  });

  it("errorCode 0 and null are no error", () => {
    assert.equal(statusView(snapshot({ errorCode: 0 }), LIVE, NOW).error, null);
    assert.equal(statusView(snapshot({ errorCode: null }), LIVE, NOW).error, null);
    assert.ok(statusView(snapshot({ errorCode: 0 }), LIVE, NOW).rows.some((r) => r.key === "Elapsed"));
  });

  it("a8 unknown print state (7)", () => {
    const v = statusView(PRESETS.a8, LIVE, NOW);
    assert.equal(v.stateLabel, "Unknown state (7)");
    assert.equal(v.tone, "neutral");
    assert.equal(v.glyph, "unknown");
    assert.equal(v.note, "State code 7 not recognised · machine: printing (1). Pause, resume, stop off.");
    assert.deepEqual(rows(v), [["Layer", "210", "/ 500"], ...TEMPS_A1]);
  });

  it("b1 offline: banner, stale label, last-known sub-line, no update clock", () => {
    const v = statusView(PRESETS.b1, LIVE, NOW);
    assert.equal(v.online, false);
    assert.deepEqual(v.banner, { strong: "No contact since 21:13", rest: ", 6 min ago. Last known values. Controls off." });
    assert.equal(v.stateLabel, "Last known: printing");
    assert.equal(v.tone, "neutral");
    assert.equal(v.glyph, "stale");
    assert.equal(v.fileName, "benchy.gcode");
    assert.equal(v.updateClock, null);
    assert.deepEqual(v.headline, { big: "1h 28m", pct: "38%", sub: "left at 21:13 · last known" });
    assert.deepEqual(v.ticks, { pct: 38, width: "38%", glow: false });
    assert.deepEqual(rows(v), [["Layer", "190", "/ 500"], ["Nozzle", "210.0°", "/ 210°"], ["Bed", "60.0°", "/ 60°"], ["Chamber", "30.2°", "—"]]);
  });

  it("the banner says just now under a minute", () => {
    const v = statusView(snapshot({ connection: "offline", updatedAt: NOW - 20_000 }), LIVE, NOW);
    assert.equal(v.banner?.rest, ", just now. Last known values. Controls off.");
  });

  it("a closed event stream is stale even when the snapshot says online (D7)", () => {
    const v = statusView(PRESETS.a1, { streamOpen: false, messageShown: false }, NOW);
    assert.equal(v.online, false);
    assert.equal(v.stateLabel, "Last known: printing");
    assert.equal(v.banner?.strong, "No contact since 21:19");
    assert.equal(isLive(PRESETS.a1, true), true);
    assert.equal(isLive(PRESETS.a1, false), false);
    assert.equal(isLive(snapshot({ connection: "connecting" }), true), false);
    assert.equal(isLive(null, true), false);
  });

  it("a shown message hides the Elapsed row", () => {
    const v = statusView(PRESETS.a1, { streamOpen: true, messageShown: true }, NOW);
    assert.deepEqual(rows(v), [["Layer", "210", "/ 500"], ...TEMPS_A1]);
  });

  it("falls back to the default printer name (D9)", () => {
    assert.equal(statusView(snapshot({ printerName: null }), LIVE, NOW).printerName, "Centauri Carbon");
    assert.equal(statusView(snapshot({ printerName: "Shop CC" }), LIVE, NOW).printerName, "Shop CC");
  });

  it("before the first snapshot: no contact yet, every value a dash", () => {
    const v = statusView(null, LIVE, NOW);
    assert.equal(v.online, false);
    assert.deepEqual(v.banner, { strong: "No contact yet.", rest: " Controls off." });
    assert.equal(v.glyph, "stale");
    assert.equal(v.fileName, null);
    assert.deepEqual(v.headline, { big: "—", pct: "—", sub: "left at — · last known" });
    assert.deepEqual(v.ticks, { pct: 0, width: "0%", glow: false });
    assert.deepEqual(rows(v), [["Nozzle", "—", "—"], ["Bed", "—", "—"], ["Chamber", "—", "—"]]);
  });

  it("null fields render as a dash", () => {
    const v = statusView(
      snapshot({
        progress: null, remaining: null, elapsed: null, layer: { current: null, total: 500 },
        temperatures: { nozzle: { current: null, target: 210 }, bed: { current: 60, target: null }, chamber: { current: null, target: null } },
      }),
      LIVE,
      NOW,
    );
    assert.deepEqual(v.headline, { big: "—", pct: "—", sub: "left · done —" });
    assert.deepEqual(v.ticks, { pct: 0, width: "0%", glow: true });
    assert.deepEqual(rows(v), [["Layer", "—", "/ 500"], ["Nozzle", "—", "/ 210°"], ["Bed", "60.0°", "—"], ["Chamber", "—", "—"]]);
  });

  it("stopped and stopping headlines", () => {
    const stopped = statusView(snapshot({ printState: { name: "stopped" } }), LIVE, NOW);
    assert.equal(stopped.stateLabel, "Stopped");
    assert.equal(stopped.glyph, "stop");
    assert.deepEqual(stopped.headline, { big: "Stopped", pct: "42%", sub: "at layer 210 / 500 · can’t be resumed" });
    const stopping = statusView(snapshot({ printState: { name: "stopping" } }), LIVE, NOW);
    assert.equal(stopping.tone, "bad");
    assert.deepEqual(stopping.headline, { big: "1h 22m", pct: "42%", sub: "left · stopping" });
    const resuming = statusView(snapshot({ printState: { name: "restoring" } }), LIVE, NOW);
    assert.equal(resuming.stateLabel, "Resuming…");
    assert.equal(resuming.headline.sub, "left · resuming");
    assert.equal(statusView(snapshot({ printState: { name: "file-checking" } }), LIVE, NOW).stateLabel, "Checking file");
  });
});

describe("duration and clock", () => {
  it("round to minutes and pad", () => {
    assert.equal(duration(4900), "1h 22m");
    assert.equal(duration(2700), "45m");
    assert.equal(duration(29), "0m");
    assert.equal(duration(null), "—");
    assert.equal(clock(NOW - 3000, true), "21:19:57");
    assert.equal(clock(NOW), "21:20");
    assert.equal(clock(null), "—");
  });
});

/** The phone track: 360 px wide sheet minus 2 × 16 px padding. */
const MAX = slideMax(328);
const page = (command: CommandState | null = null, slide: Partial<PageState["slide"]> = {}, streamOpen = true): PageState => ({
  streamOpen,
  command,
  slide: { x: 0, dragging: false, max: MAX, ...slide },
});

describe("dashboardView: controls, message, and slide", () => {
  it("a1 at rest: every control in its own fill, no message", () => {
    const v = dashboardView(PRESETS.a1, page(), NOW);
    assert.equal(v.message, null);
    assert.deepEqual(v.light, { look: "enabled", label: "Light on", disabled: false, dot: "filled", pressed: true });
    assert.deepEqual(v.pause, { look: "enabled", label: "Pause", disabled: false });
    assert.deepEqual(v.resume, { look: "disabled", label: "Resume", disabled: true });
    assert.deepEqual(v.slide, {
      pending: false, look: "enabled", disabled: false, label: "Slide to stop print", labelInk: "bad",
      thumbLeft: "3px", fillWidth: "0px", labelLeft: "0px", labelRight: "0px", labelPadLeft: "52px", pct: 0, animate: true,
    });
    assert.ok(v.status.rows.some((r) => r.key === "Elapsed"));
  });

  it("c1 holding the thumb at 74 %: consequence in the slot, Release to stop", () => {
    const x = Math.round(0.74 * MAX);
    const v = dashboardView(PRESETS.a1, page(null, { x, dragging: true }), NOW);
    assert.equal(MAX, 272);
    assert.deepEqual(v.message, {
      tone: "bad", mark: "square", title: "Stops benchy.gcode at 42%", sub: "Can’t be resumed. Release at the end to confirm.", retry: false, dismiss: false, pending: false,
    });
    assert.deepEqual(v.slide, {
      pending: false, look: "enabled", disabled: false, label: "Release to stop", labelInk: "text",
      thumbLeft: "204px", fillWidth: "255px", labelLeft: "0px", labelRight: "124px", labelPadLeft: "0px", pct: 74, animate: false,
    });
    assert.equal(328 - Number.parseFloat(v.slide.labelRight), 204, "the label ends at the thumb's left edge (track client width 328)");
    assert.equal(v.status.rows.some((r) => r.key === "Elapsed"), false, "the message hides the Elapsed row");
  });

  it("before half the track the label reads Keep sliding beside the thumb", () => {
    const v = dashboardView(PRESETS.a1, page(null, { x: 100, dragging: true }), NOW);
    assert.equal(v.slide.label, "Keep sliding");
    assert.equal(v.slide.labelInk, "bad");
    assert.equal(v.slide.labelLeft, "151px");
    assert.equal(v.slide.labelRight, "0px");
    assert.equal(v.slide.fillWidth, "154px");
    assert.equal(v.message?.title, "Stops benchy.gcode at 42%");
  });

  it("no consequence within the first 2 %, and the job is named when the file is not", () => {
    assert.equal(dashboardView(PRESETS.a1, page(null, { x: 5, dragging: true }), NOW).message, null);
    const noFile = dashboardView(snapshot({ fileName: null }), page(null, { x: 100, dragging: true }), NOW);
    assert.equal(noFile.message?.title, "Stops the job at 42%");
  });

  it("c2 stop pending: Stopping… track, no message, everything disabled", () => {
    const v = dashboardView(PRESETS.a1, page({ action: "stop", status: "pending" }), NOW);
    assert.equal(v.slide.pending, true);
    assert.equal(v.slide.disabled, true);
    assert.equal(v.slide.label, "Waiting for printer…");
    assert.equal(v.message, null);
    assert.deepEqual(v.pause, { look: "disabled", label: "Pause", disabled: true });
    assert.deepEqual(v.light, { look: "disabled", label: "Light on", disabled: true, dot: "hollow", pressed: true });
    assert.ok(v.status.rows.some((r) => r.key === "Elapsed"));
  });

  it("c3 pause pending: blue ring on Pause, Sending pause…, every control disabled", () => {
    const v = dashboardView(PRESETS.a1, page({ action: "pause", status: "pending" }), NOW);
    assert.deepEqual(v.pause, { look: "pending", label: "Pausing…", disabled: true });
    assert.deepEqual(v.message, {
      tone: "info", mark: "round", title: "Sending pause…", sub: "Waiting for printer · up to 10 s", retry: false, dismiss: false, pending: true,
    });
    assert.equal(v.light.disabled, true);
    assert.equal(v.resume.disabled, true);
    assert.deepEqual([v.slide.disabled, v.slide.look, v.slide.label, v.slide.labelInk], [true, "disabled", "Waiting for printer…", "muted"]);
  });

  it("pending labels of resume and light", () => {
    assert.equal(dashboardView(PRESETS.a4, page({ action: "resume", status: "pending" }), NOW).resume.label, "Resuming…");
    assert.equal(dashboardView(PRESETS.a1, page({ action: "light", status: "pending" }), NOW).light.label, "Light…");
  });

  it("c4 pause failed with code 2: Retry on Pause and in the slot", () => {
    const v = dashboardView(PRESETS.a1, page({ action: "pause", status: "failed", code: 2 }), NOW);
    assert.deepEqual(v.pause, { look: "failed", label: "Retry", disabled: false });
    assert.deepEqual(v.message, {
      tone: "bad", mark: "square", title: "Pause failed · code 2", sub: "Printer rejected it. Nothing changed.", retry: true, dismiss: true, pending: false,
    });
    assert.equal(v.light.disabled, false);
    assert.equal(v.slide.label, "Slide to stop print");
  });

  it("c5 pause timed out: warn tone with Retry", () => {
    const v = dashboardView(PRESETS.a1, page({ action: "pause", status: "timeout" }), NOW);
    assert.deepEqual(v.pause, { look: "failed", label: "Retry", disabled: false });
    assert.deepEqual(v.message, {
      tone: "warn", mark: "round", title: "Pause timed out", sub: "No reply in 10 s. Check state first.", retry: true, dismiss: true, pending: false,
    });
  });

  it("acknowledged messages per action", () => {
    const ack = (action: ControlAction) => dashboardView(PRESETS.a1, page({ action, status: "ack" }), NOW).message;
    assert.deepEqual(ack("pause"), { tone: "ok", mark: "round", title: "Pause acknowledged", sub: "Printer is pausing.", retry: false, dismiss: false, pending: false });
    assert.equal(ack("resume")?.sub, "Printer is resuming.");
    assert.equal(ack("stop")?.title, "Stop acknowledged");
    assert.equal(ack("stop")?.sub, "Printer is stopping.");
    assert.equal(ack("light")?.sub, "Chamber light switched.");
  });

  it("a failure without a code, or of the request itself, gives no code and the reason", () => {
    const noCode = dashboardView(PRESETS.a1, page({ action: "pause", status: "failed", code: null }), NOW).message;
    assert.equal(noCode?.title, "Pause failed");
    assert.equal(noCode?.sub, "Printer rejected it. Nothing changed.");
    const http = dashboardView(PRESETS.a1, page({ action: "pause", status: "failed", reason: "Service unreachable." }), NOW).message;
    assert.equal(http?.title, "Pause failed");
    assert.equal(http?.sub, "Service unreachable.");
    assert.equal(http?.retry, true);
  });

  it("a failed or timed-out stop shows on the track, with no Retry in the slot", () => {
    const failed = dashboardView(PRESETS.a1, page({ action: "stop", status: "failed", code: 2 }), NOW);
    assert.deepEqual([failed.slide.look, failed.slide.label, failed.slide.disabled], ["failed", "Stop failed · code 2 · again", false]);
    assert.equal(failed.message?.title, "Stop failed · code 2");
    assert.equal(failed.message?.retry, false);
    const timeout = dashboardView(PRESETS.a1, page({ action: "stop", status: "timeout" }), NOW);
    assert.deepEqual([timeout.slide.look, timeout.slide.label], ["failed", "Stop timed out · again"]);
    assert.equal(timeout.message?.retry, false);
    const noCode = dashboardView(PRESETS.a1, page({ action: "stop", status: "failed", code: null }), NOW);
    assert.equal(noCode.slide.label, "Stop failed · again");
  });

  it("a failed or timed-out stop message can be dismissed with ×, even once the job can no longer be stopped", () => {
    for (const status of ["failed", "timeout"] as const) {
      for (const snap of [PRESETS.a1, snapshot({ printState: { name: "stopped" } })]) {
        const message = dashboardView(snap, page({ action: "stop", status }), NOW).message;
        assert.equal(message?.retry, false, `stop ${status}: no Retry`);
        assert.equal(message?.dismiss, true, `stop ${status}: × shown`);
      }
    }
  });

  it("states every disabled reason on the stop track", () => {
    const reason = (snap: StatusSnapshot, p = page()) => {
      const v = dashboardView(snap, p, NOW).slide;
      assert.equal(v.disabled, true);
      assert.equal(v.look, "disabled");
      assert.equal(v.labelInk, "muted");
      return v.label;
    };
    assert.equal(reason(PRESETS.b1), "Stop unavailable offline");
    assert.equal(reason(PRESETS.a1, page(null, {}, false)), "Stop unavailable offline");
    assert.equal(reason(PRESETS.a8), "Stop off · unknown state");
    assert.equal(reason(PRESETS.a3), "Wait for the printer");
    assert.equal(reason(snapshot({ printState: { name: "restoring" } })), "Wait for the printer");
    assert.equal(reason(snapshot({ printState: { name: "stopping" } })), "Wait for the printer");
    assert.equal(reason(PRESETS.a2, page({ action: "pause", status: "pending" })), "Wait for the printer");
    assert.equal(reason(PRESETS.a1, page({ action: "light", status: "pending" })), "Waiting for printer…");
    assert.equal(reason(PRESETS.a5), "No print to stop");
    assert.equal(reason(PRESETS.a6), "No print to stop");
    assert.equal(reason(snapshot({ printState: { name: "stopped" } })), "No print to stop");
  });

  it("Light reads on with a filled dot, off with a hollow one, and — disabled when unknown", () => {
    assert.deepEqual(dashboardView(PRESETS.a1, page(), NOW).light, { look: "enabled", label: "Light on", disabled: false, dot: "filled", pressed: true });
    assert.deepEqual(dashboardView(PRESETS.a6, page(), NOW).light, { look: "enabled", label: "Light off", disabled: false, dot: "hollow", pressed: false });
    assert.deepEqual(dashboardView(snapshot({ light: "unknown" }), page(), NOW).light, { look: "disabled", label: "Light —", disabled: true, dot: "hollow", pressed: false });
  });

  it("each control is enabled exactly when isAllowed accepts it", () => {
    const names: Array<PrintStateName | "unknown"> = [
      "idle", "stopping", "stopped", "completed", "preparing", "pausing", "paused", "file-checking", "restoring", "printing", "unknown",
    ];
    for (const name of names) {
      for (const light of ["on", "off", "unknown"] as const) {
        for (const connection of ["online", "offline", "connecting"] as const) {
          const snap = snapshot({ printState: { name, code: name === "unknown" ? 7 : 13 }, light, connection });
          const v = dashboardView(snap, page(), NOW);
          const at = `${name}/${light}/${connection}`;
          assert.equal(!v.pause.disabled, isAllowed("pause", snap), `pause ${at}`);
          assert.equal(!v.resume.disabled, isAllowed("resume", snap), `resume ${at}`);
          assert.equal(!v.light.disabled, isAllowed("light", snap), `light ${at}`);
          assert.equal(!v.slide.disabled, isAllowed("stop", snap), `stop ${at}`);
          assert.equal(v.pause.look, v.pause.disabled ? "disabled" : "enabled", `pause look ${at}`);
          // The in-flight rule and a closed stream switch every control off.
          for (const p of [page({ action: "light", status: "pending" }), page(null, {}, false)]) {
            const off = dashboardView(snap, p, NOW);
            assert.ok(off.pause.disabled && off.resume.disabled && off.light.disabled && off.slide.disabled, `all off ${at}`);
          }
        }
      }
    }
  });
});

describe("stop slide steps", () => {
  it("travel, drag clamp, and release threshold", () => {
    assert.equal(slideMax(328), 272);
    assert.equal(slideDrag(0, 500, MAX), MAX);
    assert.equal(slideDrag(0, -5, MAX), 0);
    assert.equal(slideDrag(68, 30, MAX), 98);
    assert.equal(slideReleased(MAX - 2, MAX), true);
    assert.equal(slideReleased(MAX - 3, MAX), false);
  });

  it("→ moves a quarter and the fourth press sends; ← and Esc reset", () => {
    let x = 0;
    const steps: Array<{ x: number; send: boolean } | null> = [];
    for (let i = 0; i < 4; i++) {
      const step = slideKey("ArrowRight", x, MAX, true);
      steps.push(step);
      x = step?.x ?? x;
    }
    assert.deepEqual(steps, [{ x: 68, send: false }, { x: 136, send: false }, { x: 204, send: false }, { x: 0, send: true }]);
    assert.deepEqual(slideKey("ArrowLeft", 136, MAX, true), { x: 0, send: false });
    assert.deepEqual(slideKey("Escape", 204, MAX, true), { x: 0, send: false });
    assert.equal(slideKey("Enter", 68, MAX, true), null);
    assert.equal(slideKey("ArrowRight", 0, MAX, false), null);
  });

  it("partial keyboard progress never carries to a later stop", () => {
    // Three → presses, then the thumb loses focus: the progress is dropped.
    const blurred = { x: 204, dragging: false, max: MAX };
    assert.equal(settleSlide(blurred, true, false), true);
    assert.equal(blurred.x, 0);
    assert.deepEqual(slideKey("ArrowRight", blurred.x, MAX, true), { x: 68, send: false }, "one press after refocus does not send");
    // Three → presses, then stop becomes disabled (the job ended): dropped too, and not drawn meanwhile.
    const ended = { x: 204, dragging: false, max: MAX };
    const idle = dashboardView(PRESETS.a5, page(null, ended), NOW);
    assert.equal(idle.slide.disabled, true);
    assert.equal(idle.slide.thumbLeft, "3px");
    assert.equal(idle.slide.pct, 0);
    assert.equal(settleSlide(ended, false, true), true);
    assert.equal(ended.x, 0);
    // Held and allowed: the progress stays.
    const held = { x: 136, dragging: false, max: MAX };
    assert.equal(settleSlide(held, true, true), false);
    assert.equal(held.x, 136);
  });
});

describe("tokenView", () => {
  it("first run (d1): connect title, masked, no error", () => {
    assert.deepEqual(tokenView({ rejected: false, edited: false, shown: false }), {
      title: "Connect to printer",
      body: "The printer service needs an access token. Paste it from the service config.",
      error: false,
      inputType: "password",
      showLabel: "Show",
    });
  });

  it("rejected (d2): error until the field is edited, title kept", () => {
    const rejected = tokenView({ rejected: true, edited: false, shown: false });
    assert.equal(rejected.title, "Token not accepted");
    assert.equal(rejected.body, "The service rejected the saved token. It may have changed. Paste the current one.");
    assert.equal(rejected.error, true);
    const edited = tokenView({ rejected: true, edited: true, shown: false });
    assert.equal(edited.error, false);
    assert.equal(edited.title, "Token not accepted");
  });

  it("Show reveals the token and the button reads Hide", () => {
    const shown = tokenView({ rejected: false, edited: false, shown: true });
    assert.equal(shown.inputType, "text");
    assert.equal(shown.showLabel, "Hide");
  });
});
