// The dashboard's view model (web/view.ts) against the design references:
// every expected string is the one PrinterScreen.dc.html renders for the same
// snapshot (docs/design/reference/, states a1–a8 and b1).
process.env.TZ = "UTC";

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { StatusSnapshot } from "../src/status-store.ts";
import { type StatusPageState, type StatusView, clock, duration, isLive, statusView } from "../web/view.ts";

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
