// Visual harness (design D14): renders the real dashboard in Chromium for every
// state of the design references and compares each one with its reference PNG.
// It never talks to a printer or the service: it starts its own HTTP server on
// 127.0.0.1 that serves the dashboard files plus mocked /api/status,
// /api/events (held open), /api/command, and /camera, chosen per browser
// context by a `vstate` cookie.
//
// Usage:
//   node scripts/visual-check.ts [ids…] [--all-widths]
//
//   ids           a1–a8, b1–b2, c1–c5, d1–d2, e1–e4, f1–f2, g1, g2 (default: all)
//   --all-widths  also shoot each screen id at the other width (360 ↔ 1280)
//
// Output in scratch/visual/ (git-ignored):
//   <id>-dark.png, <id>-light.png   the page in both themes (360 × 780; f1, f2 1280 × 660)
//   <id>-ref.png                    the reference cropped to the same size
//   <id>-diff.png                   the actual shot in grey, differing pixels in magenta
//                                   (faint for small deltas such as anti-aliasing, solid for large ones)
//   <id>-actual.png                 g1, g2 only: the rendered icons or splash composed for comparison
//   index.html                      reference | actual | diff per id, with the diff share
//   report.json                     the same results, machine-readable
// For each id it prints the share of pixels whose colour differs by more than 8
// in any channel between the reference and the shot in the reference's theme.
//
// Environment:
//   CHROMIUM_PATH  a full Chromium executable (default: Playwright's own Chromium,
//                  channel "chromium"; `pnpm exec playwright-core install chromium`)
//
// The shots are deterministic for one browser build and font setup. The
// headless shell (Playwright's default for headless Chromium) rasterises text
// differently and shifts every share by several percent, so the harness never
// uses it and refuses a CHROMIUM_PATH that names it. The references' file name
// and clocks use the platform monospace font that `ui-monospace, …, monospace`
// resolves to; the harness prints that font and warns when it is not the one
// the references show (REFERENCE_MONO).
//
// Needs the fonts (`pnpm fonts:fetch`): without them the page falls back to
// system fonts and nothing can match, so the harness refuses to run.
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { type Browser, chromium, type Page } from "playwright-core";
import { dashboardFiles } from "../src/dashboard-files.ts";
import { SPLASHES, splashFile } from "./render-icons.ts";
import type { StatusSnapshot } from "../src/status-store.ts";

const ROOT = new URL("../", import.meta.url);
const OUT = new URL("scratch/visual/", ROOT);
const REF = new URL("docs/design/reference/", ROOT);
const ICONS = new URL("web/icons/", ROOT);
const FONTS = ["satoshi-400", "satoshi-500", "satoshi-700", "cabinet-grotesk-800"];

/** The references' fixed clock: 2026-11-13 21:20:00, read as UTC (the browser runs in UTC). */
const NOW = Date.UTC(2026, 10, 13, 21, 20, 0);
/** Per-channel difference above which a pixel counts as differing. */
const TOLERANCE = 8;
/** Where CSS animations are frozen (ms), per id: puts the indeterminate bar where each reference shows it. */
const ANIMATION_TIME_MS: Record<string, number> = { c2: 184, c3: 275 };
/** The component's maxX() before its track is mounted (360 and 1280 wide), which the references show. */
const FALLBACK_TRAVEL = { 360: 272, 1280: 334 } as const;
/**
 * Where the references' frame sits below the pixel grid (px). The design canvas
 * placed each card at a fractional y: a static Chromium render of
 * PrinterScreen.dc.html matches every reference only with its frame moved down
 * by 0.375 to 0.42 px (24/64 to 27/64 layout units; a7 rules out more), and is 1 px off where an
 * edge lands on a fraction (b1's sheet, a8's note, d2's token screen) at 0. The
 * harness puts the page at the same offset; the page itself sits on the grid.
 */
const REFERENCE_FRAME_Y = 0.40625;
/** The platform font the references' monospace text (file name, clocks) was drawn in. */
const REFERENCE_MONO = "WenQuanYi Zen Hei Mono";
/** Time limit for one interaction step, so a missing control is reported quickly. */
const STEP_MS = 2000;
/** localStorage key of the access token (web/app.ts). */
const TOKEN_KEY = "printer-token";

type Theme = "dark" | "light";

// ---- States: PrinterScreen.dc.html's preset(), verbatim ----

interface Temp {
  current: number;
  target: number;
}
interface PresetSnap {
  connection: string;
  machine: { name: string; code: number };
  print: { name: string; code: number };
  fileName: string;
  progress: number;
  layer: { current: number; total: number };
  elapsed: number;
  remaining: number;
  t: { nozzle: Temp; bed: Temp; chamber: Temp };
  light: string;
  errorCode: number | null;
  updatedAt: number;
}
type SnapPatch = Partial<Omit<PresetSnap, "print">> & { print?: Partial<PresetSnap["print"]> };
interface Preset {
  snap?: SnapPatch;
  cam?: boolean;
  slide?: number;
  cmd?: { action: string; status: "pending" | "failed" | "timeout"; code?: number };
  token?: boolean;
  val?: string;
  err?: boolean;
}

const N = NOW;
const BASE: PresetSnap = {
  connection: "online", machine: { name: "printing", code: 1 }, print: { name: "printing", code: 13 }, fileName: "benchy.gcode", progress: 42, layer: { current: 210, total: 500 }, elapsed: 3600, remaining: 4900,
  t: { nozzle: { current: 210.1, target: 210 }, bed: { current: 59.9, target: 60 }, chamber: { current: 30.5, target: 0 } }, light: "on", errorCode: null, updatedAt: N - 3000,
};
const PRESETS: Record<string, Preset> = {
  printing: {},
  preparing: { snap: { print: { name: "preparing" }, progress: 0, layer: { current: 0, total: 500 }, elapsed: 40, remaining: 8460, t: { nozzle: { current: 141.6, target: 210 }, bed: { current: 52.3, target: 60 }, chamber: { current: 27.0, target: 0 } } } },
  pausing: { snap: { print: { name: "pausing" } } },
  paused: { snap: { print: { name: "paused" }, machine: { name: "paused", code: 2 }, elapsed: 3720 } },
  completed: { snap: { print: { name: "completed" }, machine: { name: "idle", code: 0 }, fileName: "", progress: 0, layer: { current: 0, total: 0 }, elapsed: 8520, remaining: 0, t: { nozzle: { current: 62.4, target: 0 }, bed: { current: 44.8, target: 0 }, chamber: { current: 33.1, target: 0 } } } },
  idle: { snap: { print: { name: "idle" }, machine: { name: "idle", code: 0 }, fileName: "", progress: 0, layer: { current: 0, total: 0 }, elapsed: 0, remaining: 0, light: "off", t: { nozzle: { current: 26.3, target: 0 }, bed: { current: 24.9, target: 0 }, chamber: { current: 23.8, target: 0 } } } },
  error: { snap: { print: { name: "paused" }, machine: { name: "paused", code: 2 }, errorCode: 45, progress: 67, layer: { current: 335, total: 500 }, elapsed: 6120, remaining: 2950, t: { nozzle: { current: 209.9, target: 210 }, bed: { current: 60.0, target: 60 }, chamber: { current: 31.2, target: 0 } } } },
  unknown: { snap: { print: { name: "unknown", code: 7 } } },
  offline: { snap: { connection: "offline", updatedAt: N - 6 * 60000 - 20000, progress: 38, layer: { current: 190, total: 500 }, elapsed: 3240, remaining: 5300, t: { nozzle: { current: 210.0, target: 210 }, bed: { current: 60.0, target: 60 }, chamber: { current: 30.2, target: 0 } } } },
  camfail: { cam: false },
  stopconfirm: { slide: 0.74 },
  "cmd-pending": { cmd: { action: "pause", status: "pending" } },
  "cmd-failed": { cmd: { action: "pause", status: "failed", code: 2 } },
  "cmd-timeout": { cmd: { action: "pause", status: "timeout" } },
  "stop-pending": { cmd: { action: "stop", status: "pending" } },
  token: { token: true, val: "" },
  "token-wrong": { token: true, val: "c3f9a1e07b2d44e8b1", err: true },
};

/** The component's merge: base, then the variant's fields, with `print` merged one level down. */
function presetSnap(variant: string): PresetSnap {
  const patch = PRESETS[variant]?.snap ?? {};
  return { ...BASE, ...patch, print: { ...BASE.print, ...(patch.print ?? {}) } } as PresetSnap;
}

/**
 * The preset as the service would send it. Field for field the same values;
 * only the shape differs: `t` is `temperatures`, an empty file name is null
 * (status-store sends null for ""), and the printer's name is the component's
 * default. The machine names "paused" and the print name "unknown" with a
 * code are the component's, kept even where the store would name them
 * differently, so the page shows what the reference shows.
 */
function toSnapshot(variant: string): StatusSnapshot {
  const s = presetSnap(variant);
  return {
    connection: s.connection,
    printerName: "Centauri Carbon",
    machineState: s.machine,
    printState: s.print,
    taskId: null,
    fileName: s.fileName === "" ? null : s.fileName,
    progress: s.progress,
    layer: s.layer,
    elapsed: s.elapsed,
    remaining: s.remaining,
    temperatures: s.t,
    light: s.light,
    errorCode: s.errorCode,
    updatedAt: s.updatedAt,
  } as StatusSnapshot;
}

type CommandMode = "ack" | "failed" | "timeout" | "hold";
type Interaction = "slide-hold" | "slide-stop" | "pause";

interface VisualState {
  id: string;
  label: string;
  variant: string;
  /** Theme of the reference PNG. */
  theme: Theme;
  width: 360 | 1280;
  command: CommandMode;
  camera: "frame" | "down";
  /** Every API request answers 401 (the token screen). */
  unauthorized: boolean;
  /** Token seeded in localStorage before the page loads. */
  storedToken: string | null;
  interaction: Interaction | null;
}

/** One state per reference id (printer-states.dc.html: id, variant, theme, width). */
const SCREENS: Array<[id: string, variant: string, theme: Theme, width: 360 | 1280, label: string]> = [
  ["a1", "printing", "dark", 360, "Printing, mid-job"],
  ["a2", "preparing", "dark", 360, "Preparing (heating)"],
  ["a3", "pausing", "dark", 360, "Pausing"],
  ["a4", "paused", "dark", 360, "Paused"],
  ["a5", "completed", "dark", 360, "Completed, file name cleared"],
  ["a6", "idle", "dark", 360, "Idle, no job"],
  ["a7", "error", "dark", 360, "Print error 45"],
  ["a8", "unknown", "dark", 360, "Unknown print state (7)"],
  ["b1", "offline", "dark", 360, "Offline, stale data"],
  ["b2", "camfail", "dark", 360, "Camera unavailable while printing"],
  ["c1", "stopconfirm", "dark", 360, "Stop confirmation: dragging, consequence shown"],
  ["c2", "stop-pending", "dark", 360, "Stop sent, pending"],
  ["c3", "cmd-pending", "dark", 360, "Pause pending"],
  ["c4", "cmd-failed", "dark", 360, "Pause failed with code"],
  ["c5", "cmd-timeout", "dark", 360, "Pause timed out after 10 s"],
  ["d1", "token", "dark", 360, "First run: token entry"],
  ["d2", "token-wrong", "dark", 360, "Wrong token (401)"],
  ["e1", "printing", "light", 360, "Printing, light"],
  ["e2", "error", "light", 360, "Error 45, light"],
  ["e3", "offline", "light", 360, "Offline, light"],
  ["e4", "token", "light", 360, "Token entry, light"],
  ["f1", "printing", "dark", 1280, "Laptop: printing, dark"],
  ["f2", "paused", "light", 1280, "Laptop: paused, light"],
];

function stateOf([id, variant, theme, width, label]: (typeof SCREENS)[number]): VisualState {
  const p = PRESETS[variant] ?? {};
  let command: CommandMode = "ack";
  let interaction: Interaction | null = null;
  if (p.cmd !== undefined) {
    command = p.cmd.status === "pending" ? "hold" : p.cmd.status;
    interaction = p.cmd.action === "stop" ? "slide-stop" : "pause";
  }
  if (p.slide !== undefined) interaction = "slide-hold";
  return {
    id, label, variant, theme, width, command, interaction,
    camera: p.cam === false ? "down" : "frame",
    unauthorized: p.token === true,
    storedToken: p.err === true ? (p.val ?? null) : null,
  };
}

const STATES = new Map(SCREENS.map((row) => [row[0], stateOf(row)]));
const ICON_IDS = ["g1", "g2"];

// ---- Mock server ----

const open = new Set<ServerResponse>();
const frames = new Map<number, Buffer>();
const files = dashboardFiles();

function stateFor(req: IncomingMessage): VisualState | undefined {
  const id = /(?:^|;\s*)vstate=([\w-]+)/.exec(req.headers.cookie ?? "")?.[1];
  return id === undefined ? undefined : STATES.get(id);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function hold(res: ServerResponse): void {
  open.add(res);
  res.on("close", () => open.delete(res));
}

async function serveFile(res: ServerResponse, dir: URL, name: string): Promise<void> {
  if (!/^[\w.-]+\.png$/.test(name) || !existsSync(new URL(name, dir))) return void json(res, 404, { error: "not found" });
  res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" });
  res.end(await readFile(new URL(name, dir)));
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  if (path === "/__blank") return void res.end("<!doctype html><title>compare</title>");
  if (path.startsWith("/__out/")) return serveFile(res, OUT, path.slice(7));
  if (path.startsWith("/__ref/")) return serveFile(res, REF, path.slice(7));
  if (path.startsWith("/__icons/")) return serveFile(res, ICONS, path.slice(9));
  if (files.has(path)) return files.serve(path, res);

  const state = stateFor(req);
  if (state === undefined) return void json(res, 404, { error: "no vstate cookie" });
  if (state.unauthorized && (path.startsWith("/api/") || path === "/camera")) {
    return void json(res, 401, { error: { code: "unauthorized", message: "missing or wrong access token" } });
  }
  const snapshot = toSnapshot(state.variant);
  if (path === "/api/status") return void json(res, 200, snapshot);
  if (path === "/api/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(`event: status\ndata: ${JSON.stringify(snapshot)}\n\n`);
    return hold(res);
  }
  if (path === "/api/command" && req.method === "POST") {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const action = (JSON.parse(raw || "{}") as { action?: string }).action ?? "pause";
    if (state.command === "hold") return hold(res);
    if (state.command === "failed") return void json(res, 200, { action, outcome: "failed", code: 2 });
    if (state.command === "timeout") return void json(res, 200, { action, outcome: "timeout" });
    return void json(res, 200, { action, outcome: "acknowledged" });
  }
  if (path === "/camera") {
    if (state.camera === "down") return void json(res, 502, { error: { code: "camera-unavailable", message: "camera unavailable" } });
    // The frame for the width being shot (the vwidth cookie), so --all-widths shots get their own box size.
    const width = Number(/(?:^|;\s*)vwidth=(\d+)/.exec(req.headers.cookie ?? "")?.[1] ?? state.width);
    const frame = frames.get(width) ?? Buffer.alloc(0);
    res.writeHead(200, { "Content-Type": "multipart/x-mixed-replace; boundary=frame", "Cache-Control": "no-store" });
    res.write(Buffer.concat([Buffer.from(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`), frame, Buffer.from("\r\n")]));
    return hold(res);
  }
  json(res, 404, { error: "not found" });
}

// ---- Browser side ----

/** The component's mock stream (stripes and label) at the camera box size, as a JPEG frame. */
async function renderFrame(browser: Browser, width: number, height: number, inset: string): Promise<Buffer> {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await page.setContent(`<body style="margin:0"><div style="position:relative;width:${width}px;height:${height}px;overflow:hidden">
    <div style="position:absolute;inset:0;background:repeating-linear-gradient(135deg,#1c1c1c 0 10px,#171717 10px 20px)"></div>
    <div style="position:absolute;inset:${inset};display:grid;place-items:center"><span style="font-family:ui-monospace,'SF Mono','Cascadia Code',Consolas,monospace;font-size:11.5px;color:#8b8b8b;-webkit-font-smoothing:antialiased">camera · mjpeg stream</span></div>
  </div></body>`);
  const jpeg = await page.screenshot({ type: "jpeg", quality: 100 });
  await page.close();
  return jpeg;
}

/**
 * The phone's own status-bar clock (design D5), which the page does not draw:
 * 13 px / 700 at left 16 px, top 10 px over the camera (#ececec), or centred in
 * a 36 px band on the token screen (the theme's text colour).
 */
function overlayClock({ onToken, theme }: { onToken: boolean; theme: Theme }): Promise<unknown> {
  const g = globalThis as any;
  const doc = g.document;
  const face = doc.createElement("style");
  face.textContent = "@font-face{font-family:'VisualSatoshi';src:url('/fonts/satoshi-700.woff2') format('woff2');font-weight:700}";
  doc.head.append(face);
  const el = doc.createElement("div");
  el.textContent = "21:20";
  const place = onToken ? "top:0;height:36px;display:flex;align-items:center;" : "top:10px;";
  const color = onToken ? (theme === "dark" ? "#ececec" : "#161616") : "#ececec";
  el.setAttribute("style", `position:fixed;left:16px;${place}z-index:2147483647;pointer-events:none;font-family:'VisualSatoshi','Satoshi',ui-sans-serif,system-ui,sans-serif;font-size:13px;font-weight:700;color:${color};-webkit-font-smoothing:antialiased`);
  doc.documentElement.append(el);
  return doc.fonts.load("700 13px VisualSatoshi");
}

/** Freezes every CSS animation (not transitions) at `time` ms, so animated parts shoot the same every run. */
function freezeAnimations(time: number): void {
  for (const a of (globalThis as any).document.getAnimations()) {
    if (a.constructor.name !== "CSSAnimation") continue;
    a.pause();
    a.currentTime = time;
  }
}

/** Runs the state's interaction by role; returns a note when the control is not there. */
async function interact(page: Page, state: VisualState, width: 360 | 1280): Promise<string | null> {
  if (state.interaction === null) return null;
  try {
    if (state.interaction === "pause") {
      await page.getByRole("button", { name: "Pause", exact: true }).click({ timeout: STEP_MS });
      return null;
    }
    const slider = page.getByRole("slider").first();
    await slider.waitFor({ state: "visible", timeout: STEP_MS });
    // The element with role=slider is the thumb (D12); when it is the whole track, start at its thumb.
    const geo = await slider.evaluate((el: any) => {
      const r = el.getBoundingClientRect();
      const isTrack = r.width >= 100;
      let track = el;
      if (!isTrack) {
        track = el.parentElement;
        while (track !== null && track.clientWidth < r.width + 50) track = track.parentElement;
      }
      const t = track.getBoundingClientRect();
      return { x: isTrack ? t.left + 1 + 3 + 24 : r.left + r.width / 2, y: r.top + r.height / 2, max: track.clientWidth - 2 - 6 - 48 };
    });
    // c1 holds where the reference shows the thumb: the preset's slide 0.74 of the
    // component's fallback travel (maxX() before its track is measured: 272, wide 334).
    const dx = state.interaction === "slide-hold" ? Math.min(geo.max, Math.round(0.74 * FALLBACK_TRAVEL[width])) : geo.max;
    await page.mouse.move(geo.x, geo.y);
    await page.mouse.down();
    await page.mouse.move(geo.x + dx, geo.y, { steps: 12 });
    if (state.interaction === "slide-stop") await page.mouse.up();
    return null;
  } catch (error) {
    const what = state.interaction === "pause" ? 'button "Pause"' : "slider (role=slider)";
    return `interaction unreachable: ${what}: ${String((error as Error).message).split("\n")[0]}`;
  }
}

async function shoot(browser: Browser, base: string, state: VisualState, theme: Theme, width: 360 | 1280, file: string): Promise<string | null> {
  const viewport = width === 360 ? { width: 360, height: 780 } : { width: 1280, height: 660 };
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, timezoneId: "UTC", locale: "en-GB", colorScheme: theme, serviceWorkers: "block" });
  try {
    await context.addCookies([{ name: "vstate", value: state.id, url: base }, { name: "vwidth", value: String(width), url: base }]);
    await context.addInitScript(
      ({ theme, key, token }: { theme: Theme; key: string; token: string | null }) => {
        const storage = (globalThis as any).localStorage;
        storage.setItem("theme", theme);
        if (token !== null) storage.setItem(key, token);
      },
      { theme, key: TOKEN_KEY, token: state.storedToken },
    );
    const page = await context.newPage();
    await page.clock.setFixedTime(NOW);
    await page.goto(`${base}/`, { waitUntil: "load" });
    await page.evaluate(() => (globalThis as any).document.fonts.ready.then(() => true));
    await page.waitForTimeout(800);
    const interaction = await interact(page, state, width);
    await page.waitForTimeout(500);
    const overflow = await page.evaluate(() => {
      const root = (globalThis as any).document.documentElement;
      return root.scrollWidth - root.clientWidth;
    });
    const note = [interaction, overflow > 0 ? `horizontal scroll at ${width} px (${theme}): ${overflow} px` : null].filter((n) => n !== null).join("; ") || null;
    await page.evaluate(freezeAnimations, ANIMATION_TIME_MS[state.id] ?? 275);
    await page.addStyleTag({ content: `html{position:relative;top:${REFERENCE_FRAME_Y}px}` });
    if (width === 360) await page.evaluate(overlayClock, { onToken: state.unauthorized, theme });
    await page.screenshot({ path: new URL(file, OUT).pathname, caret: "hide" });
    return note;
  } finally {
    await context.close();
  }
}

// ---- Comparison (in the browser's canvas, so no image library is needed) ----

/** One layer of an image composed in the canvas: an image (scaled when w/h are given) or a fill. */
interface Layer {
  src?: string;
  fill?: string;
  x: number;
  y: number;
  w?: number;
  h?: number;
}
interface CompareInput {
  ref: Layer[];
  actual: Layer[];
  w: number;
  h: number;
  /** Count only these rectangles (g1's icons); the whole image when absent. */
  regions?: Array<{ x: number; y: number; w: number; h: number }>;
  /** Count only where these layers, drawn alone, are fully opaque (g1: the icons' own shape, not the sheet's shadow). */
  opaque?: Layer[];
  /** Leave out these rings (g1: the sheet's dashed safe-zone circle drawn over the 512 icon). */
  rings?: Array<{ cx: number; cy: number; r0: number; r1: number }>;
  tolerance: number;
}
interface CompareOutput {
  share: number;
  ref: string;
  actual: string;
  diff: string;
}

async function compareInBrowser(input: CompareInput): Promise<CompareOutput> {
  const doc = (globalThis as any).document;
  const compose = async (layers: Layer[]) => {
    const canvas = doc.createElement("canvas");
    canvas.width = input.w;
    canvas.height = input.h;
    const g = canvas.getContext("2d");
    for (const layer of layers) {
      if (layer.fill !== undefined) {
        g.fillStyle = layer.fill;
        g.fillRect(layer.x, layer.y, layer.w, layer.h);
        continue;
      }
      const img = new (globalThis as any).Image();
      img.src = layer.src;
      await img.decode();
      if (layer.w === undefined) g.drawImage(img, layer.x, layer.y);
      else g.drawImage(img, layer.x, layer.y, layer.w, layer.h);
    }
    return { canvas, data: g.getImageData(0, 0, input.w, input.h) };
  };
  const ref = await compose(input.ref);
  const act = await compose(input.actual);
  const mask = input.opaque === undefined ? null : (await compose(input.opaque)).data.data;
  const out = doc.createElement("canvas");
  out.width = input.w;
  out.height = input.h;
  const og = out.getContext("2d");
  const diff = og.createImageData(input.w, input.h);
  const a = ref.data.data;
  const b = act.data.data;
  const inRegion = (x: number, y: number) =>
    (input.regions === undefined || input.regions.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h)) &&
    (mask === null || mask[(y * input.w + x) * 4 + 3] === 255) &&
    !(input.rings ?? []).some((r) => {
      const d = Math.hypot(x + 0.5 - r.cx, y + 0.5 - r.cy);
      return d >= r.r0 && d <= r.r1;
    });
  let counted = 0;
  let differing = 0;
  for (let y = 0; y < input.h; y++) {
    for (let x = 0; x < input.w; x++) {
      const i = (y * input.w + x) * 4;
      const lum = 0.299 * b[i] + 0.587 * b[i + 1] + 0.114 * b[i + 2];
      const grey = 150 + lum * 0.4;
      let delta = 0;
      if (inRegion(x, y)) {
        counted++;
        for (let c = 0; c < 4; c++) delta = Math.max(delta, Math.abs(a[i + c] - b[i + c]));
        if (delta > input.tolerance) differing++;
      }
      // Differing pixels in magenta, faint for small deltas (anti-aliasing), solid from 90 up.
      const t = delta > input.tolerance ? Math.min(1, 0.3 + delta / 128) : 0;
      diff.data[i] = grey + (255 - grey) * t;
      diff.data[i + 1] = grey * (1 - t);
      diff.data[i + 2] = grey + (170 - grey) * t;
      diff.data[i + 3] = 255;
    }
  }
  og.putImageData(diff, 0, 0);
  return { share: counted === 0 ? 0 : differing / counted, ref: ref.canvas.toDataURL("image/png"), actual: act.canvas.toDataURL("image/png"), diff: out.toDataURL("image/png") };
}

function png(dataUrl: string): Buffer {
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
}

// g1 (450 × 353): where the reference sheet shows the icon at 512 (drawn at 256), 180 (at 90), and 48.
const G1_BOXES = [
  { x: 0, y: 30, w: 256, h: 256, src: "icon-512.png" },
  { x: 284, y: 196, w: 90, h: 90, src: "apple-touch-icon.png" },
  { x: 402, y: 238, w: 48, h: 48, src: "icon-192.png" },
];
const G1_SHEET = "#f0eee6";

/** g1/g2 layers, or null while their PNGs do not exist yet. */
async function iconInput(id: string): Promise<{ input: Omit<CompareInput, "tolerance">; note: string } | null> {
  if (id === "g1") {
    if (!G1_BOXES.every((box) => existsSync(new URL(box.src, ICONS)))) return null;
    const actual: Layer[] = [{ src: "/__ref/g1.png", x: 0, y: 0 }];
    for (const box of G1_BOXES) actual.push({ fill: G1_SHEET, x: box.x, y: box.y, w: box.w, h: box.h }, { src: `/__icons/${box.src}`, x: box.x, y: box.y, w: box.w, h: box.h });
    return {
      input: {
        ref: [{ src: "/__ref/g1.png", x: 0, y: 0 }],
        actual,
        w: 450,
        h: 353,
        regions: G1_BOXES.map(({ x, y, w, h }) => ({ x, y, w, h })),
        opaque: G1_BOXES.map((box) => ({ src: `/__icons/${box.src}`, x: box.x, y: box.y, w: box.w, h: box.h })),
        // The 512 icon's safe zone: a dashed circle at an inset of 25.6 px of the 256 px tile.
        rings: [{ cx: 128, cy: 30 + 128, r0: 100.5, r1: 103.5 }],
      },
      note: "rendered icons placed on the reference sheet; share counts the icons' opaque pixels only (the drop shadow and the dashed safe-zone circle are the sheet's)",
    };
  }
  // The splash drawn at its CSS size and centred on the 360 × 780 frame, as the phone shows it.
  // Picks the screen nearest the frame whose margins are whole pixels, so nothing is resampled
  // apart from the device-pixel downscale.
  const present = SPLASHES.filter((s) => existsSync(new URL(splashFile(s), ICONS)) && (s.width - 360) % 2 === 0 && (s.height - 780) % 2 === 0);
  if (present.length === 0) return null;
  const best = present.sort((p, q) => Math.abs(p.width - 360) + Math.abs(p.height - 780) - (Math.abs(q.width - 360) + Math.abs(q.height - 780)))[0]!;
  return {
    input: {
      ref: [{ src: "/__ref/g2.png", x: 0, y: 0 }],
      actual: [{ src: `/__icons/${splashFile(best)}`, x: (360 - best.width) / 2, y: (780 - best.height) / 2, w: best.width, h: best.height }],
      w: 360,
      h: 780,
    },
    note: `${splashFile(best)} at ${best.width} × ${best.height} CSS px, centred on the 360 × 780 frame; the reference's rounded corners are its card's`,
  };
}

// ---- Report ----

interface Result {
  id: string;
  label: string;
  theme: Theme | null;
  width: number;
  height: number;
  share: number | null;
  notes: string[];
  shots: string[];
  extra: string[];
}

const esc = (text: string) => text.replace(/[&<>"]/g, (c) => `&${({ "&": "amp", "<": "lt", ">": "gt", '"': "quot" } as Record<string, string>)[c]};`);
const pct = (share: number | null) => (share === null ? "—" : `${(share * 100).toFixed(2)}%`);

function indexHtml(results: Result[], setup: string): string {
  const rows = results.map((r) => `<tr><td><a href="#${r.id}">${r.id}</a></td><td>${esc(r.label)}</td><td>${r.theme ?? "—"}</td><td class="num">${pct(r.share)}</td><td>${esc(r.notes.join(" · "))}</td></tr>`).join("\n");
  const fig = (src: string, caption: string, w: number) => `<figure><img src="${src}" width="${w}" alt="${esc(caption)}"><figcaption>${esc(caption)}</figcaption></figure>`;
  const sections = results.map((r) => {
    const compared = r.share !== null;
    const figures = [
      compared ? fig(`${r.id}-ref.png`, `reference (${r.theme})`, r.width) : "",
      ...(compared && r.id.startsWith("g") ? [fig(`${r.id}-actual.png`, "actual", r.width)] : []),
      ...r.shots.map((shot) => fig(shot, `actual ${shot.replace(/^\w+-|\.png$/g, "")}`, r.width)),
      compared ? fig(`${r.id}-diff.png`, `diff · ${pct(r.share)} differ (tolerance ${TOLERANCE})`, r.width) : "",
      ...r.extra.map((shot) => fig(shot, `other width ${shot.replace(/^\w+-|\.png$/g, "")}`, Number(/-(\d+)\.png$/.exec(shot)?.[1] ?? 360))),
    ].filter(Boolean);
    return `<section id="${r.id}"><h2>${r.id} · ${esc(r.label)} <span class="share">${pct(r.share)}</span></h2>${r.notes.map((n) => `<p class="note">${esc(n)}</p>`).join("")}<div class="row${r.width > 400 ? " wide" : ""}">${figures.join("")}</div></section>`;
  });
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Visual check</title>
<style>
body{margin:0;padding:24px;background:#e9e8e4;color:#161616;font:14px/1.45 system-ui,sans-serif}
table{border-collapse:collapse;margin-bottom:32px}td,th{padding:4px 10px;border-bottom:1px solid #ccc;text-align:left}.num{text-align:right;font-variant-numeric:tabular-nums}
section{margin:0 0 40px}h2{font-size:16px;margin:0 0 8px}.share{font-variant-numeric:tabular-nums;color:#a0006b}.note{margin:0 0 8px;color:#6b4500}
.row{display:flex;gap:16px;align-items:flex-start;overflow-x:auto}.row.wide{flex-direction:column}
figure{margin:0;flex:none}img{display:block;image-rendering:pixelated;outline:1px solid rgba(0,0,0,.2)}figcaption{font-size:12px;color:#555;margin-top:4px}
</style></head><body>
<h1>Visual check</h1>
<p>Each row: the reference cropped to the shot's size, the page in the reference's theme and the other theme, and the diff (the shot in grey, pixels differing by more than ${TOLERANCE} in any channel in magenta, faint for small deltas such as font anti-aliasing, solid for large ones). Clock fixed at 2026-11-13 21:20:00 UTC. The page is shot ${REFERENCE_FRAME_Y} px below the pixel grid, where the references' frame sits. The magenta corners (about 0.2 %) are the reference card's rounded corners, not page content.</p>
<p>${esc(setup)}</p>
<table><tr><th>id</th><th>state</th><th>ref theme</th><th>diff share</th><th>notes</th></tr>
${rows}
</table>
${sections.join("\n")}
</body></html>
`;
}

// ---- Main ----

function usage(message: string): never {
  console.error(`${message}\nusage: node scripts/visual-check.ts [${[...STATES.keys(), ...ICON_IDS].join(" ")}] [--all-widths]`);
  process.exit(2);
}

const args = process.argv.slice(2);
const allWidths = args.includes("--all-widths");
const ids = args.filter((arg) => arg !== "--all-widths");
for (const id of ids) if (!STATES.has(id) && !ICON_IDS.includes(id)) usage(`unknown id or option: ${id}`);
const selected = ids.length > 0 ? ids : [...STATES.keys(), ...ICON_IDS];

const missingFonts = FONTS.filter((name) => !existsSync(new URL(`web/fonts/${name}.woff2`, ROOT)));
if (missingFonts.length > 0) {
  console.error(`visual-check: missing fonts in web/fonts/ (${missingFonts.join(", ")}). Run \`pnpm fonts:fetch\` first: without them nothing can match the references.`);
  process.exit(1);
}

await mkdir(OUT, { recursive: true });
const server = createServer((req, res) => {
  handle(req, res).catch((error: unknown) => {
    console.error(`visual-check: ${req.url}: ${String(error)}`);
    if (!res.headersSent) json(res, 500, { error: "harness error" });
    else res.destroy();
  });
});
server.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const chromiumPath = process.env.CHROMIUM_PATH || undefined;
if (chromiumPath !== undefined && /headless[-_]shell/.test(chromiumPath)) {
  console.error(`visual-check: CHROMIUM_PATH names the headless shell (${chromiumPath}); it renders text differently from the references. Point it at a full Chromium, or unset it.`);
  process.exit(1);
}
const browser = await chromium.launch(chromiumPath !== undefined ? { executablePath: chromiumPath } : { channel: "chromium" });

/** The platform font the page's monospace stack resolves to (the file name and clocks). */
async function monospaceFont(): Promise<string> {
  const page = await browser.newPage();
  try {
    await page.setContent(`<span style="font-family:ui-monospace,'SF Mono','Cascadia Code',Consolas,monospace">benchy.gcode 21:19:57</span>`);
    const cdp = await page.context().newCDPSession(page);
    const { root } = await cdp.send("DOM.getDocument");
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: "span" });
    await cdp.send("CSS.enable");
    const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
    return fonts.map((font) => font.familyName).join(", ");
  } finally {
    await page.close();
  }
}

try {
  const mono = await monospaceFont();
  const setup = `Chromium ${browser.version()} (${chromiumPath ?? "Playwright channel chromium"}); monospace: ${mono}`;
  console.log(`visual-check: ${setup}`);
  if (mono !== REFERENCE_MONO) console.warn(`visual-check: warning: the references' monospace text is ${REFERENCE_MONO}; with ${mono} the file name and clocks will differ.`);
  frames.set(360, await renderFrame(browser, 360, 240, "88px 16px 44px"));
  frames.set(1280, await renderFrame(browser, 1280 - 24 - 468, 660 - 84 - 24, "16px"));

  const results: Result[] = [];
  for (const id of selected) {
    const state = STATES.get(id);
    if (state === undefined) {
      results.push({ id, label: id === "g1" ? "App icon" : "Splash", theme: null, width: id === "g1" ? 450 : 360, height: id === "g1" ? 353 : 780, share: null, notes: [], shots: [], extra: [] });
      continue;
    }
    const result: Result = { id, label: state.label, theme: state.theme, width: state.width, height: state.width === 360 ? 780 : 660, share: null, notes: [], shots: [], extra: [] };
    for (const theme of [state.theme, state.theme === "dark" ? "light" : "dark"] as Theme[]) {
      const file = `${id}-${theme}.png`;
      const note = await shoot(browser, base, state, theme, state.width, file);
      if (note !== null && !result.notes.includes(note)) result.notes.push(note);
      result.shots.push(file);
      if (allWidths) {
        const other = state.width === 360 ? 1280 : 360;
        const extra = `${id}-${theme}-${other}.png`;
        const extraNote = await shoot(browser, base, state, theme, other, extra);
        if (extraNote !== null && !result.notes.includes(extraNote)) result.notes.push(extraNote);
        result.extra.push(extra);
      }
    }
    results.push(result);
  }

  // Compare in one blank page on the harness origin, so the canvas is never tainted.
  const context = await browser.newContext({ serviceWorkers: "block" });
  const page = await context.newPage();
  await page.goto(`${base}/__blank`);
  for (const result of results) {
    let input: Omit<CompareInput, "tolerance">;
    if (result.theme === null) {
      const icon = await iconInput(result.id);
      if (icon === null) {
        result.notes.push(result.id === "g1" ? "no rendered icons in web/icons/ yet" : "no web/icons/splash-<w>x<h>.png yet (node scripts/render-icons.ts)");
        continue;
      }
      input = icon.input;
      result.notes.push(icon.note);
    } else {
      input = { ref: [{ src: `/__ref/${result.id}.png`, x: 0, y: 0 }], actual: [{ src: `/__out/${result.id}-${result.theme}.png`, x: 0, y: 0 }], w: result.width, h: result.height };
    }
    const out = await page.evaluate(compareInBrowser, { ...input, tolerance: TOLERANCE });
    result.share = out.share;
    await writeFile(new URL(`${result.id}-ref.png`, OUT), png(out.ref));
    await writeFile(new URL(`${result.id}-diff.png`, OUT), png(out.diff));
    if (result.theme === null) await writeFile(new URL(`${result.id}-actual.png`, OUT), png(out.actual));
  }
  await context.close();

  await writeFile(new URL("index.html", OUT), indexHtml(results, setup));
  await writeFile(new URL("report.json", OUT), `${JSON.stringify({ setup, results: results.map(({ id, theme, share, notes }) => ({ id, theme, share, notes })) }, null, 2)}\n`);
  for (const r of results) {
    const notes = r.notes.length > 0 ? `  (${r.notes.join("; ")})` : "";
    console.log(`${r.id.padEnd(3)} ${pct(r.share).padStart(7)} differ${notes}`);
  }
  console.log(`\nsee ${new URL("index.html", OUT).pathname}`);
} finally {
  await browser.close();
  for (const res of open) res.destroy();
  server.close();
}
