// Presentation rules of the dashboard (design D1, D10): a pure function of the
// status snapshot, the page's own state, and the time, returning the values the
// page writes into the DOM. The rules follow `renderVals()` in
// docs/design/reference/PrinterScreen.dc.html, string for string. Besides
// types it imports only the shared control rules, so `node --test` tests it
// and the browser loads it as /view.js.
import { type ControlAction, isAllowed } from "../src/control-rules.ts";
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

// ---- Controls, message slot, and stop slide (design D8, D12) ----

/** An acknowledged command's message clears itself after this long. */
export const ACK_CLEAR_MS = 2600;

/** The command in flight or last answered; one at a time (design D8). */
export interface CommandState {
  action: ControlAction;
  status: "pending" | "ack" | "failed" | "timeout";
  /** The printer's code for a failed command; null or absent when there is none. */
  code?: number | null;
  /** Why the request itself failed (HTTP error, network); replaces the sub-line. */
  reason?: string;
}

/** The stop thumb: offset in px from the start, the drag in progress, and the track's travel. */
export interface SlideState {
  x: number;
  dragging: boolean;
  /** Travel in px, `slideMax(track width)`. */
  max: number;
}

export interface PageState {
  streamOpen: boolean;
  command: CommandState | null;
  slide: SlideState;
}

/** enabled: the control's own fill; disabled: dashed, no fill; pending: blue ring; failed: Retry in the bad tone. */
export type ControlLook = "enabled" | "disabled" | "pending" | "failed";

export interface ButtonView {
  look: ControlLook;
  label: string;
  disabled: boolean;
}

export interface LightView extends ButtonView {
  /** Filled while the light is on and the button usable, else a hollow ring. */
  dot: "filled" | "hollow";
  /** `aria-pressed`. */
  pressed: boolean;
}

export interface MessageView {
  tone: Exclude<Tone, "neutral">;
  /** The 8 px mark: round (50 %) or a square with 2 px corners. */
  mark: "round" | "square";
  title: string;
  sub: string;
  /** Shows Retry. */
  retry: boolean;
  /** Shows the × dismiss button: on every failure or timeout, stop's too, so no message is stuck. */
  dismiss: boolean;
  /** Shows the indeterminate bar. */
  pending: boolean;
}

export interface SlideView {
  /** The track reads "Stopping…" with a blue ring instead of the thumb. */
  pending: boolean;
  look: Exclude<ControlLook, "pending">;
  disabled: boolean;
  label: string;
  /** Label ink: the bad tone, full text past half the track, or muted when disabled. */
  labelInk: "bad" | "text" | "muted";
  thumbLeft: string;
  fillWidth: string;
  labelLeft: string;
  labelRight: string;
  labelPadLeft: string;
  /** `aria-valuenow`, 0–100. */
  pct: number;
  /** Spring-back transition on (off while dragging). */
  animate: boolean;
}

export interface DashboardView {
  status: StatusView;
  message: MessageView | null;
  light: LightView;
  pause: ButtonView;
  resume: ButtonView;
  slide: SlideView;
}

const VERB: Record<ControlAction, string> = { pause: "Pause", resume: "Resume", stop: "Stop", light: "Light" };
const PENDING_LABEL: Record<Exclude<ControlAction, "stop">, string> = { pause: "Pausing…", resume: "Resuming…", light: "Light…" };
const ACK_TEXT: Record<ControlAction, string> = {
  pause: "Printer is pausing.",
  resume: "Printer is resuming.",
  stop: "Printer is stopping.",
  light: "Chamber light switched.",
};

/** The thumb's travel on a track `trackWidth` px wide (1 px border, 3 px inset, 48 px thumb). */
export function slideMax(trackWidth: number): number {
  return trackWidth - 2 - 6 - 48;
}

/** Thumb offset while dragging from `start` by `dx` px. */
export function slideDrag(start: number, dx: number, max: number): number {
  return Math.max(0, Math.min(max, start + dx));
}

/** A release at this offset sends the stop. */
export function slideReleased(x: number, max: number): boolean {
  return x >= max - 2;
}

/**
 * Progress on the thumb lasts only while stop is allowed and the thumb is held
 * (dragged or focused): otherwise it returns to the start, so partial → presses
 * never count toward a later stop. Mutates `slide`; true when it moved.
 */
export function settleSlide(slide: SlideState, enabled: boolean, held: boolean): boolean {
  if (slide.x === 0 || (enabled && held)) return false;
  slide.x = 0;
  return true;
}

/**
 * Keyboard on the thumb: → moves a quarter of the track and the fourth press
 * sends stop (the thumb returns to the start); ← and Esc reset. Null for any
 * other key, or when the slide is disabled.
 */
export function slideKey(key: string, x: number, max: number, enabled: boolean): { x: number; send: boolean } | null {
  if (!enabled) return null;
  if (key === "ArrowRight") {
    const next = Math.min(max, x + max / 4);
    return next >= max ? { x: 0, send: true } : { x: next, send: false };
  }
  if (key === "ArrowLeft" || key === "Escape") return { x: 0, send: false };
  return null;
}

/**
 * Whether Retry may re-send a failed or timed-out command: never for stop (it
 * is sent from the slide again), and otherwise only while the service would
 * accept it (online, and allowed by the control rules), as for the buttons.
 */
export function canRetry(cmd: CommandState | null, snapshot: StatusSnapshot | null, streamOpen: boolean): boolean {
  if (cmd === null || (cmd.status !== "failed" && cmd.status !== "timeout") || cmd.action === "stop") return false;
  return isLive(snapshot, streamOpen) && isAllowed(cmd.action, snapshot ?? EMPTY);
}

function messageOf(cmd: CommandState | null, dragShown: boolean, snap: StatusSnapshot | null, streamOpen: boolean): MessageView | null {
  if (dragShown) {
    return {
      tone: "bad",
      mark: "square",
      title: `Stops ${snap?.fileName || "the job"} at ${snap?.progress ?? NONE}%`,
      sub: "Can’t be resumed. Release at the end to confirm.",
      retry: false,
      dismiss: false,
      pending: false,
    };
  }
  if (cmd === null || (cmd.action === "stop" && cmd.status === "pending")) return null;
  const verb = VERB[cmd.action];
  const retry = canRetry(cmd, snap, streamOpen);
  switch (cmd.status) {
    case "pending":
      return { tone: "info", mark: "round", title: `Sending ${verb.toLowerCase()}…`, sub: "Waiting for printer · up to 10 s", retry: false, dismiss: false, pending: true };
    case "ack":
      return { tone: "ok", mark: "round", title: `${verb} acknowledged`, sub: ACK_TEXT[cmd.action], retry: false, dismiss: false, pending: false };
    case "failed":
      return {
        tone: "bad",
        mark: "square",
        title: `${verb} failed${cmd.code == null ? "" : ` · code ${cmd.code}`}`,
        sub: cmd.reason ?? "Printer rejected it. Nothing changed.",
        retry,
        dismiss: true,
        pending: false,
      };
    case "timeout":
      return { tone: "warn", mark: "round", title: `${verb} timed out`, sub: cmd.reason ?? "No reply in 10 s. Check state first.", retry, dismiss: true, pending: false };
  }
}

/** The whole dashboard: status, message slot, buttons, and stop slide. */
export function dashboardView(snapshot: StatusSnapshot | null, page: PageState, now: number): DashboardView {
  const snap = snapshot ?? EMPTY;
  const online = isLive(snapshot, page.streamOpen);
  const cmd = page.command;
  const pending = cmd !== null && cmd.status === "pending";
  const failedAct = cmd !== null && (cmd.status === "failed" || cmd.status === "timeout") ? cmd.action : null;
  const ok = (action: ControlAction): boolean => online && !pending && isAllowed(action, snap);

  const button = (action: Exclude<ControlAction, "stop">, label: string): ButtonView => {
    if (pending && cmd?.action === action) return { look: "pending", label: PENDING_LABEL[action], disabled: true };
    if (!ok(action)) return { look: "disabled", label, disabled: true };
    if (failedAct === action) return { look: "failed", label: "Retry", disabled: false };
    return { look: "enabled", label, disabled: false };
  };
  const lightKnown = snap.light === "on" || snap.light === "off";
  const lightButton = button("light", lightKnown ? `Light ${snap.light}` : "Light —");
  const light: LightView = {
    ...lightButton,
    dot: snap.light === "on" && !lightButton.disabled ? "filled" : "hollow",
    pressed: snap.light === "on",
  };

  const okStop = ok("stop");
  const { max, dragging } = page.slide;
  const x = okStop ? Math.max(0, Math.min(max, page.slide.x)) : 0;
  const frac = max ? x / max : 0;
  const dragShown = okStop && frac > 0.02;
  const pname = snap.printState.name;
  let reason = "No print to stop";
  if (!online) reason = "Stop unavailable offline";
  else if (pname === "unknown") reason = "Stop off · unknown state";
  else if (["pausing", "restoring", "stopping", "preparing"].includes(pname) && !okStop) reason = "Wait for the printer";
  else if (pending) reason = "Waiting for printer…";

  let label = reason;
  let look: SlideView["look"] = "disabled";
  let labelInk: SlideView["labelInk"] = "muted";
  if (okStop) {
    labelInk = "bad";
    if (failedAct === "stop") {
      look = "failed";
      label = cmd?.status === "failed" ? `Stop failed${cmd.code == null ? "" : ` · code ${cmd.code}`} · again` : "Stop timed out · again";
    } else {
      look = "enabled";
      label = "Slide to stop print";
    }
  }
  let labelLeft = "0px";
  let labelRight = "0px";
  let labelPadLeft = "52px";
  if (dragShown && frac >= 0.5) {
    // Ends at the thumb's left edge (track client width max + 56, less 3 + x), as the
    // references show; the component's max + 54 assumes its unmeasured 272 px travel.
    labelRight = `${max + 56 - (x + 3)}px`;
    labelPadLeft = "0px";
    label = "Release to stop";
    labelInk = "text";
  } else if (dragShown) {
    labelLeft = `${x + 51}px`;
    labelPadLeft = "0px";
    label = "Keep sliding";
  }
  const slide: SlideView = {
    pending: pending && cmd?.action === "stop",
    look,
    disabled: !okStop,
    label,
    labelInk,
    thumbLeft: `${3 + x}px`,
    fillWidth: dragShown ? `${x + 54}px` : "0px",
    labelLeft,
    labelRight,
    labelPadLeft,
    pct: Math.round(frac * 100),
    animate: !dragging,
  };

  const message = messageOf(cmd, dragShown, snapshot, page.streamOpen);
  return {
    status: statusView(snapshot, { streamOpen: page.streamOpen, messageShown: message !== null }, now),
    message,
    light,
    pause: button("pause", "Pause"),
    resume: button("resume", "Resume"),
    slide,
  };
}

// ---- Token screen ----

export interface TokenPageState {
  /** The service answered 401 to the token in the field. */
  rejected: boolean;
  /** The field was edited since the rejection. */
  edited: boolean;
  /** The token is shown in clear. */
  shown: boolean;
}

export interface TokenView {
  title: string;
  body: string;
  /** Red ring, aria-invalid, and the "Rejected (401)." alert. */
  error: boolean;
  inputType: "text" | "password";
  showLabel: "Show" | "Hide";
}

/** The token screen's texts and looks (the component's token variants). */
export function tokenView(page: TokenPageState): TokenView {
  return {
    title: page.rejected ? "Token not accepted" : "Connect to printer",
    body: page.rejected
      ? "The service rejected the saved token. It may have changed. Paste the current one."
      : "The printer service needs an access token. Paste it from the service config.",
    error: page.rejected && !page.edited,
    inputType: page.shown ? "text" : "password",
    showLabel: page.shown ? "Hide" : "Show",
  };
}
