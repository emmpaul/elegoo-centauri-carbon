// Presentation rules of the dashboard (design D1, D10): a pure function of the
// status snapshot, the page's own state, and the time, returning the values the
// page writes into the DOM. The rules follow `renderVals()` in
// docs/design/reference/PrinterScreen.dc.html, string for string. It imports
// only types, so `node --test` tests it and the browser loads it as /view.js.
import type { PrintStateName, StatusSnapshot, Temperature } from "../src/status-store.ts";

/** Header name when the printer has not reported one (design D9). */
export const DEFAULT_PRINTER_NAME = "Centauri Carbon";
const NONE = "—";

export type Tone = "ok" | "warn" | "info" | "bad" | "neutral";
export type Glyph = "run" | "busy" | "pause" | "stop" | "done" | "idle" | "unknown" | "stale";
type PrintName = PrintStateName | "unknown";

const LABEL: Record<Exclude<PrintName, "unknown">, string> = {
  idle: "Idle",
  preparing: "Preparing",
  "file-checking": "Checking file",
  printing: "Printing",
  pausing: "Pausing…",
  paused: "Paused",
  restoring: "Resuming…",
  stopping: "Stopping…",
  stopped: "Stopped",
  completed: "Complete",
};
const TONE: Record<PrintName, Tone> = {
  printing: "ok",
  preparing: "info",
  "file-checking": "info",
  restoring: "info",
  pausing: "warn",
  paused: "warn",
  stopping: "bad",
  stopped: "neutral",
  completed: "ok",
  idle: "neutral",
  unknown: "neutral",
};
const GLYPH: Record<PrintName, Glyph> = {
  printing: "run",
  preparing: "busy",
  "file-checking": "busy",
  restoring: "busy",
  pausing: "busy",
  paused: "pause",
  stopping: "busy",
  stopped: "stop",
  completed: "done",
  idle: "idle",
  unknown: "unknown",
};

/** What the page knows besides the snapshot. */
export interface StatusPageState {
  /** The event stream to the service is open. */
  streamOpen: boolean;
  /** The message slot above the controls shows something (it hides the Elapsed row). */
  messageShown: boolean;
}

export interface Row {
  key: string;
  value: string;
  /** The right-hand column: a target, a total, or empty. */
  target: string;
}

export interface StatusView {
  printerName: string;
  /** False: stale treatment, "Offline" in the header, every control off (design D7). */
  online: boolean;
  /** Offline banner: the bold part, then the rest of the sentence; null when online. */
  banner: { strong: string; rest: string } | null;
  stateLabel: string;
  tone: Tone;
  glyph: Glyph;
  /** Null hides the file slot. */
  fileName: string | null;
  /** Time of the last update, HH:MM:SS; null hides it (offline). */
  updateClock: string | null;
  headline: { big: string; pct: string; sub: string };
  /** Ticks: filled share in percent (filled in the tone), and whether the fill glows (dark theme only). */
  ticks: { pct: number; width: string; glow: boolean };
  error: { title: string; text: string } | null;
  /** Neutral note for an unknown print state; null otherwise. */
  note: string | null;
  rows: Row[];
}

/** Before the first snapshot every value is unknown. */
const EMPTY: StatusSnapshot = {
  connection: "connecting",
  printerName: null,
  machineState: { name: "unknown", code: null },
  printState: { name: "unknown", code: null },
  taskId: null,
  fileName: null,
  progress: null,
  layer: { current: null, total: null },
  elapsed: null,
  remaining: null,
  temperatures: {
    nozzle: { current: null, target: null },
    bed: { current: null, target: null },
    chamber: { current: null, target: null },
  },
  light: "unknown",
  errorCode: null,
  updatedAt: null,
};

/** Online means the event stream is open and the service reports the printer online (design D7). */
export function isLive(snapshot: StatusSnapshot | null, streamOpen: boolean): boolean {
  return streamOpen && snapshot !== null && snapshot.connection === "online";
}

/** Seconds as rounded minutes: "1h 22m", "45m". */
export function duration(seconds: number | null): string {
  if (seconds === null) return NONE;
  const m = Math.round(seconds / 60);
  const h = Math.floor(m / 60);
  return h ? `${h}h ${String(m % 60).padStart(2, "0")}m` : `${m}m`;
}

/** Local 24 h clock, "HH:MM" or with seconds "HH:MM:SS". */
export function clock(ms: number | null, seconds = false): string {
  if (ms === null) return NONE;
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}${seconds ? `:${p(d.getSeconds())}` : ""}`;
}

function stateLabel(snapshot: StatusSnapshot): string {
  const { name, code } = snapshot.printState;
  return name === "unknown" ? `Unknown state (${code ?? NONE})` : LABEL[name];
}

function degrees(value: number | null): string {
  return value === null ? NONE : `${value.toFixed(1)}°`;
}

/** Target column: "off" at 0, "→ T°" more than 2° away, else "/ T°". */
function target(t: Temperature): string {
  if (t.target === null) return NONE;
  if (!t.target) return "off";
  return t.current !== null && Math.abs(t.current - t.target) > 2 ? `→ ${t.target}°` : `/ ${t.target}°`;
}

/** The snapshot's error code counts when it is set and not 0 (0 means no error). */
function errorOf(snapshot: StatusSnapshot): StatusView["error"] {
  const code = snapshot.errorCode;
  if (code === null || code === 0) return null;
  return {
    title: `Error ${code}${code === 45 ? " · filament low" : ""}`,
    text: code === 45 ? "Load filament, then resume." : "Check the printer screen for details.",
  };
}

function bannerOf(snapshot: StatusSnapshot, now: number): StatusView["banner"] {
  if (snapshot.updatedAt === null) return { strong: "No contact yet.", rest: " Controls off." };
  const ago = Math.round((now - snapshot.updatedAt) / 60_000);
  return {
    strong: `No contact since ${clock(snapshot.updatedAt)}`,
    rest: `, ${ago < 1 ? "just now" : `${ago} min ago`}. Last known values. Controls off.`,
  };
}

/** The status part of the screen: header, status line, headline, ticks, alerts, and rows. */
export function statusView(snapshotOrNull: StatusSnapshot | null, page: StatusPageState, now: number): StatusView {
  const snap = snapshotOrNull ?? EMPTY;
  const online = isLive(snapshotOrNull, page.streamOpen);
  const stale = !online;
  const pname = snap.printState.name;
  // Stale values take the neutral inks (the component's text-3 / text-2), never a state colour.
  const tone: Tone = stale ? "neutral" : TONE[pname];
  const error = online ? errorOf(snap) : null;
  const T = snap.temperatures;
  const ended = pname === "completed" || pname === "idle";

  const rows: Row[] = [];
  if (snap.layer.total && !ended) rows.push({ key: "Layer", value: String(snap.layer.current ?? NONE), target: `/ ${snap.layer.total}` });
  if (snap.elapsed && !ended && online && error === null && pname !== "unknown" && !page.messageShown) {
    rows.push({ key: "Elapsed", value: duration(snap.elapsed), target: "" });
  }
  rows.push({ key: "Nozzle", value: degrees(T.nozzle.current), target: target(T.nozzle) });
  rows.push({ key: "Bed", value: degrees(T.bed.current), target: target(T.bed) });
  rows.push({ key: "Chamber", value: degrees(T.chamber.current), target: NONE });

  const eta = snap.updatedAt === null || snap.remaining === null ? NONE : clock(snap.updatedAt + snap.remaining * 1000);
  let big = duration(snap.remaining);
  let pct = snap.progress === null ? NONE : `${snap.progress}%`;
  let sub = `left · done ${eta}`;
  let tickPct = snap.progress ?? 0;
  if (pname === "preparing" || pname === "file-checking") sub = "estimated · heating up";
  if (pname === "pausing") sub = "left · pausing";
  if (pname === "paused") sub = "left · timer held";
  if (pname === "restoring") sub = "left · resuming";
  if (pname === "completed") {
    big = duration(snap.elapsed);
    pct = "Done";
    sub = `total print time · bed ${T.bed.current === null ? NONE : Math.round(T.bed.current)}°, let it cool`;
    tickPct = 100;
  }
  if (pname === "idle") {
    big = "Ready";
    pct = "";
    sub = "No job. Start one from the printer or slicer.";
    tickPct = 0;
  }
  if (pname === "stopped") {
    big = "Stopped";
    sub = `at layer ${snap.layer.current ?? NONE} / ${snap.layer.total ?? NONE} · can’t be resumed`;
  }
  if (pname === "stopping") sub = "left · stopping";
  if (stale) sub = `left at ${clock(snap.updatedAt)} · last known`;

  const label = stateLabel(snap);
  return {
    printerName: snap.printerName ?? DEFAULT_PRINTER_NAME,
    online,
    banner: online ? null : bannerOf(snap, now),
    stateLabel: stale ? `Last known: ${label.toLowerCase()}` : label,
    tone,
    glyph: stale ? "stale" : GLYPH[pname],
    fileName: snap.fileName ? snap.fileName : null,
    updateClock: online ? clock(snap.updatedAt, true) : null,
    headline: { big, pct, sub },
    ticks: { pct: tickPct, width: `${tickPct}%`, glow: tone !== "neutral" },
    error,
    note:
      pname === "unknown"
        ? `State code ${snap.printState.code ?? NONE} not recognised · machine: ${snap.machineState.name} (${snap.machineState.code ?? NONE}). Pause, resume, stop off.`
        : null,
    rows,
  };
}
