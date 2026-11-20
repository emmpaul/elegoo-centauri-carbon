// PROTOTYPE, throwaway (branch prototype/charts-q9). Answers grilling Q9 of the
// "temperature and progress charts" change: where do the charts go on the dashboard?
// Two variants, switchable with `?variant=A|B` and the bottom bar (or ← →):
//   A  a "Charts" section under the Nozzle / Bed / Chamber rows, always visible
//   B  sparklines inside the rows; tapping a row opens a panel with both full charts
// Readings are synthetic (one every 10 s, made up in the browser), not the service's.
// Loaded by app.ts only when `?variant=` is in the URL.

interface Reading {
  t: number; // ms since epoch
  nozzle: number; nozzleTarget: number;
  bed: number; bedTarget: number;
  chamber: number;
  progress: number | null; layer: number | null;
  speed: number | null;
  fanModel: number; fanAux: number; fanBox: number;
  z: number | null;
  state: State; light: boolean;
}
type State = "idle" | "preparing" | "printing" | "paused" | "material" | "cooling";

const STEP = 10_000;
const MIN = 60_000;
const START = Date.now() - 300 * MIN; // first Reading, 5 h ago (idle)
const JOB_START = Date.now() - 280 * MIN;
const PRINT_START = JOB_START + 8 * MIN;
const JOB_LENGTH = 340 * MIN; // printing time it would take, so we are mid-job now
const LAYERS = 500;
const GAP = [Date.now() - 120 * MIN, Date.now() - 112 * MIN] as const; // service down: no Readings

// ---- Synthetic Readings ----

function noise(t: number, k: number): number {
  return Math.sin(t / 37_000 + k) * 0.35 + Math.sin(t / 7_100 + k * 3) * 0.2;
}

function approach(from: number, to: number, elapsed: number, tau: number): number {
  return to + (from - to) * Math.exp(-elapsed / tau);
}

function readingAt(t: number): Reading {
  const m = (t - JOB_START) / MIN;
  let state: State = "idle";
  if (t >= JOB_START) state = t < PRINT_START ? "preparing" : "printing";
  if (m >= 80 && m < 90) state = "paused";
  if (m >= 130 && m < 133) state = "material";
  const nozzleTarget = state === "idle" ? 0 : state === "paused" ? 170 : 220;
  const bedTarget = state === "idle" ? 0 : 60;
  const sinceStart = Math.max(0, t - JOB_START);
  let nozzle = state === "idle" ? 26 : approach(26, 220, sinceStart, 50_000);
  if (state === "paused") nozzle = approach(220, 170, t - (JOB_START + 80 * MIN), 60_000);
  if (m >= 90 && m < 92) nozzle = approach(170, 220, t - (JOB_START + 90 * MIN), 30_000);
  const bed = state === "idle" ? 25 : approach(25, 60, sinceStart, 90_000);
  const chamber = state === "idle" ? 24 : 24 + 14 * (1 - Math.exp(-sinceStart / (60 * MIN)));
  // Printing time: ticks stop while paused and during the material change.
  let printed = Math.max(0, t - PRINT_START);
  if (m >= 80) printed -= Math.min(t - (JOB_START + 80 * MIN), 10 * MIN);
  if (m >= 130) printed -= Math.min(t - (JOB_START + 130 * MIN), 3 * MIN);
  const speed = state === "idle" || state === "preparing" ? null : m >= 180 && m < 220 ? 130 : 100;
  const effective = printed * (m >= 180 ? 1.08 : 1);
  const progress = state === "idle" ? null : Math.min(100, Math.round((effective / JOB_LENGTH) * 100));
  const layer = progress === null ? null : Math.max(1, Math.round((effective / JOB_LENGTH) * LAYERS));
  const printing = state === "printing" || state === "material";
  return {
    t,
    nozzle: nozzle + noise(t, 1), nozzleTarget,
    bed: bed + noise(t, 2) * 0.4, bedTarget,
    chamber: chamber + noise(t, 3) * 0.2,
    progress, layer, speed,
    fanModel: printing ? (layer !== null && layer > 3 ? 100 : 0) : 0,
    fanAux: printing && m > 60 ? 40 : 0,
    fanBox: state === "idle" ? 0 : m > 100 ? 60 : 30,
    z: layer === null ? null : Math.round(layer * 0.2 * 10) / 10,
    state,
    light: !(m >= 30 && m < 50),
  };
}

const readings: Reading[] = [];
for (let t = START; t <= Date.now(); t += STEP) if (t < GAP[0] || t >= GAP[1]) readings.push(readingAt(t));

// ---- Chart rendering (hand-written SVG) ----

const COLORS = {
  nozzle: "var(--bad)", bed: "var(--warn)", chamber: "var(--info)",
  progress: "var(--ok)", speed: "var(--text)", fanModel: "var(--info)", fanAux: "#b48cf2", fanBox: "var(--warn)", z: "var(--text-3)",
};
const STATE_FILL: Record<State, string> = {
  idle: "transparent", preparing: "var(--info)", printing: "var(--ok)", paused: "var(--warn)", material: "#b48cf2", cooling: "var(--text-3)",
};
const STATE_LABEL: Record<State, string> = {
  idle: "Idle", preparing: "Preparing", printing: "Printing", paused: "Paused", material: "Material change", cooling: "Cooling",
};

interface Series {
  key: string; label: string; color: string;
  get: (r: Reading) => number | null;
  dash?: boolean; step?: boolean; right?: boolean; unit: string;
}

const TEMP_SERIES: Series[] = [
  { key: "nozzle", label: "Nozzle", color: COLORS.nozzle, get: (r) => r.nozzle, unit: "°" },
  { key: "nozzleTarget", label: "target", color: COLORS.nozzle, get: (r) => r.nozzleTarget || null, dash: true, step: true, unit: "°" },
  { key: "bed", label: "Bed", color: COLORS.bed, get: (r) => r.bed, unit: "°" },
  { key: "bedTarget", label: "target", color: COLORS.bed, get: (r) => r.bedTarget || null, dash: true, step: true, unit: "°" },
  { key: "chamber", label: "Chamber", color: COLORS.chamber, get: (r) => r.chamber, unit: "°" },
];
const JOB_SERIES: Series[] = [
  { key: "progress", label: "Progress", color: COLORS.progress, get: (r) => r.progress, unit: "%" },
  { key: "speed", label: "Speed", color: COLORS.speed, get: (r) => r.speed, step: true, unit: "%" },
  { key: "fanModel", label: "Part fan", color: COLORS.fanModel, get: (r) => r.fanModel, step: true, unit: "%" },
  { key: "fanAux", label: "Aux fan", color: COLORS.fanAux, get: (r) => r.fanAux, step: true, unit: "%" },
  { key: "fanBox", label: "Chamber fan", color: COLORS.fanBox, get: (r) => r.fanBox, step: true, unit: "%" },
  { key: "z", label: "Z", color: COLORS.z, get: (r) => r.z, right: true, unit: " mm" },
];
const hidden = new Set<string>(["fanAux", "fanBox"]);

interface ChartOptions {
  series: Series[]; t0: number; t1: number; width: number; height: number;
  yMax: number; yMin?: number; rightMax?: number; cursor: number | null; bands: boolean; axes: boolean;
}

function inRange(t0: number, t1: number): Reading[] {
  return readings.filter((r) => r.t >= t0 && r.t <= t1);
}

function chartSvg(o: ChartOptions): string {
  const padL = o.axes ? 30 : 0, padR = o.axes && o.rightMax ? 34 : o.axes ? 6 : 0, padT = o.bands ? 10 : 2, padB = o.axes ? 16 : 2;
  const w = o.width - padL - padR, h = o.height - padT - padB;
  const x = (t: number) => padL + ((t - o.t0) / (o.t1 - o.t0)) * w;
  const y = (v: number, right?: boolean) => padT + h - (right ? v / o.rightMax! : (v - (o.yMin ?? 0)) / (o.yMax - (o.yMin ?? 0))) * h;
  const rs = inRange(o.t0, o.t1);
  let out = `<svg class="pc-svg" viewBox="0 0 ${o.width} ${o.height}" width="${o.width}" height="${o.height}" role="img">`;
  if (o.bands) {
    // State strip at the top, tinted columns for pause and material change, hatched offline gaps.
    for (let i = 0; i < rs.length; i++) {
      const r = rs[i]!, next = rs[i + 1];
      const end = next && next.t - r.t <= 3 * STEP ? next.t : r.t + STEP;
      const fill = STATE_FILL[r.state];
      if (fill !== "transparent") out += `<rect x="${x(r.t)}" y="0" width="${Math.max(0.5, x(end) - x(r.t))}" height="5" fill="${fill}" opacity="0.8"/>`;
      if (r.state === "paused" || r.state === "material") out += `<rect x="${x(r.t)}" y="${padT}" width="${Math.max(0.5, x(end) - x(r.t))}" height="${h}" fill="${fill}" opacity="0.1"/>`;
      if (r.light) out += `<rect x="${x(r.t)}" y="6" width="${Math.max(0.5, x(end) - x(r.t))}" height="2" fill="var(--text-3)" opacity="0.6"/>`;
      if (next && next.t - r.t > 3 * STEP) {
        out += `<rect x="${x(r.t)}" y="${padT}" width="${x(next.t) - x(r.t)}" height="${h}" fill="url(#pc-hatch)"/>`;
        if (o.axes) out += `<text x="${(x(r.t) + x(next.t)) / 2}" y="${padT + 12}" class="pc-axis" text-anchor="middle">offline</text>`;
      }
    }
  }
  if (o.axes) {
    for (const f of [0, 0.5, 1]) {
      const v = Math.round(o.yMax * f);
      out += `<line x1="${padL}" x2="${padL + w}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/>`;
      out += `<text x="${padL - 4}" y="${y(v) + 3}" class="pc-axis" text-anchor="end">${v}</text>`;
      if (o.rightMax) out += `<text x="${padL + w + 4}" y="${y(o.rightMax * f, true) + 3}" class="pc-axis">${Math.round(o.rightMax * f)}</text>`;
    }
    const span = o.t1 - o.t0, stepMs = span > 12 * 60 * MIN ? 4 * 60 * MIN : span > 3 * 60 * MIN ? 60 * MIN : span > 60 * MIN ? 30 * MIN : 15 * MIN;
    for (let t = Math.ceil(o.t0 / stepMs) * stepMs; t <= o.t1; t += stepMs) {
      out += `<text x="${x(t)}" y="${o.height - 3}" class="pc-axis" text-anchor="middle">${clock(t)}</text>`;
    }
  }
  for (const s of o.series) {
    if (hidden.has(s.key)) continue;
    let d = "", prev: Reading | null = null, prevV: number | null = null;
    for (const r of rs) {
      const v = s.get(r);
      const broken = prev === null || r.t - prev.t > 3 * STEP || v === null || prevV === null;
      if (v !== null) {
        if (broken) d += `M${x(r.t).toFixed(1)},${y(v, s.right).toFixed(1)}`;
        else if (s.step) d += `H${x(r.t).toFixed(1)}V${y(v, s.right).toFixed(1)}`;
        else d += `L${x(r.t).toFixed(1)},${y(v, s.right).toFixed(1)}`;
      }
      prev = r; prevV = v;
    }
    out += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${o.axes ? 1.6 : 1.4}" ${s.dash ? 'stroke-dasharray="3 3" opacity="0.7"' : ""} stroke-linejoin="round"/>`;
  }
  if (o.cursor !== null) out += `<line x1="${x(o.cursor)}" x2="${x(o.cursor)}" y1="${padT}" y2="${padT + h}" stroke="var(--text-2)" stroke-width="1"/>`;
  out += `<defs><pattern id="pc-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" stroke="var(--text-4)" stroke-width="2" opacity="0.5"/></pattern></defs>`;
  return `${out}</svg>`;
}

function clock(t: number): string {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function nearest(t: number): Reading | null {
  let best: Reading | null = null;
  for (const r of readings) if (best === null || Math.abs(r.t - t) < Math.abs(best.t - t)) best = r;
  return best && Math.abs(best.t - t) <= 3 * STEP ? best : null;
}

function readout(t: number | null, series: Series[]): string {
  if (t === null) return "Touch or hover the chart to read values.";
  const r = nearest(t);
  if (r === null) return `${clock(t)} · offline, no Reading`;
  const parts = series.filter((s) => !hidden.has(s.key) && !s.dash).map((s) => {
    const v = s.get(r);
    return `${s.label} ${v === null ? "—" : `${Math.round(v * 10) / 10}${s.unit}`}`;
  });
  return `${clock(r.t)} · ${STATE_LABEL[r.state]}${r.light ? " · light on" : ""} · ${parts.join(" · ")}`;
}

// ---- Shared "full charts" block (both variants use it; the placement is the question) ----

type Span = "job" | "1h" | "3h" | "24h";
let range: Span = "job";
let cursor: number | null = null;

function rangeBounds(): [number, number] {
  const now = Date.now();
  if (range === "job") return [JOB_START, now];
  return [now - { "1h": 60, "3h": 180, "24h": 1440 }[range] * MIN, now];
}

function legend(series: Series[]): string {
  return `<div class="pc-legend">${series.filter((s) => !s.dash).map((s) =>
    `<button type="button" class="pc-key" data-key="${s.key}" aria-pressed="${!hidden.has(s.key)}"><i style="background:${s.color}"></i>${s.label}</button>`).join("")}
    <span class="pc-key pc-key--static"><i class="pc-dash"></i>target</span></div>`;
}

function fullCharts(root: HTMLElement): void {
  const width = Math.max(260, Math.floor(root.clientWidth || 360));
  const [t0, t1] = rangeBounds();
  const jobSeries = JOB_SERIES;
  root.innerHTML = `
    <div class="pc-range" role="group" aria-label="Time range">
      ${(["job", "1h", "3h", "24h"] as Span[]).map((k) => `<button type="button" data-range="${k}" aria-pressed="${k === range}">${k === "job" ? "This job" : k}</button>`).join("")}
    </div>
    <div class="pc-title">Temperatures <span>°C</span></div>
    <div class="pc-plot" data-plot>${chartSvg({ series: TEMP_SERIES, t0, t1, width, height: 150, yMax: 250, cursor, bands: true, axes: true })}</div>
    ${legend(TEMP_SERIES)}
    <div class="pc-readout">${readout(cursor, TEMP_SERIES)}</div>
    <div class="pc-title">Job <span>% · Z mm on the right</span></div>
    <div class="pc-plot" data-plot>${chartSvg({ series: jobSeries, t0, t1, width, height: 130, yMax: 140, rightMax: 100, cursor, bands: true, axes: true })}</div>
    ${legend(jobSeries)}
    <div class="pc-readout">${readout(cursor, jobSeries)}</div>
    <div class="pc-proto">PROTOTYPE · synthetic Readings · strip on top = state, thin line = light on, hatched = offline</div>`;
  root.querySelectorAll<HTMLButtonElement>("[data-range]").forEach((b) => b.addEventListener("click", () => { range = b.dataset.range as Span; cursor = null; fullCharts(root); }));
  root.querySelectorAll<HTMLButtonElement>("[data-key]").forEach((b) => b.addEventListener("click", () => {
    const k = b.dataset.key!;
    if (hidden.has(k)) hidden.delete(k); else hidden.add(k);
    fullCharts(root);
  }));
  root.querySelectorAll<HTMLElement>("[data-plot]").forEach((plot) => {
    const move = (e: PointerEvent) => {
      const box = plot.getBoundingClientRect();
      const padL = 30, padR = 34;
      const f = (e.clientX - box.left - padL) / (box.width - padL - padR);
      cursor = f < 0 || f > 1 ? null : t0 + f * (t1 - t0);
      fullCharts(root);
    };
    plot.addEventListener("pointerdown", move);
    plot.addEventListener("pointermove", (e) => { if (e.pointerType === "mouse" || e.buttons) move(e); });
  });
}

// ---- Variant A: a Charts section under the rows ----

function variantA(): () => void {
  const section = document.createElement("section");
  section.className = "pc-section";
  section.innerHTML = `<div class="pc-head">Charts</div><div class="pc-body"></div>`;
  document.querySelector(".rows")!.after(section);
  const body = section.querySelector<HTMLElement>(".pc-body")!;
  fullCharts(body);
  const tick = setInterval(() => { if (cursor === null) fullCharts(body); }, 10_000);
  return () => { clearInterval(tick); section.remove(); };
}

// ---- Variant B: sparklines in the rows, tap opens a panel ----

const SPARK: Record<string, Series[]> = {
  Nozzle: [TEMP_SERIES[1]!, TEMP_SERIES[0]!],
  Bed: [TEMP_SERIES[3]!, TEMP_SERIES[2]!],
  Chamber: [TEMP_SERIES[4]!],
  Layer: [JOB_SERIES[0]!],
};

function variantB(): () => void {
  const panel = document.createElement("div");
  panel.className = "pc-panel";
  panel.hidden = true;
  panel.innerHTML = `<div class="pc-scrim" data-close></div><div class="pc-dialog" role="dialog" aria-label="Charts"><div class="pc-dialog__head"><span class="pc-head">Charts</span><button type="button" class="pc-close" data-close aria-label="Close">×</button></div><div class="pc-body"></div></div>`;
  document.body.append(panel);
  const body = panel.querySelector<HTMLElement>(".pc-body")!;
  const open = () => { panel.hidden = false; cursor = null; fullCharts(body); };
  panel.querySelectorAll("[data-close]").forEach((el) => el.addEventListener("click", () => { panel.hidden = true; }));
  const rows = document.querySelector<HTMLElement>(".rows")!;
  const onRowClick = (e: Event) => { if ((e.target as HTMLElement).closest(".row")) open(); };
  rows.addEventListener("click", onRowClick);
  rows.classList.add("pc-tappable");
  const sparks = () => {
    const t1 = Date.now(), t0 = t1 - 30 * MIN;
    for (const row of Array.from(rows.children) as HTMLElement[]) {
      const key = row.children[0]?.textContent ?? "";
      let spark = row.querySelector<HTMLElement>(".pc-spark");
      const series = SPARK[key];
      if (!series) { spark?.remove(); continue; }
      if (!spark) { spark = document.createElement("span"); spark.className = "pc-spark"; row.append(spark); }
      const all = inRange(t0, t1).flatMap((r) => series.map((s) => s.get(r) ?? 0));
      const lo = Math.min(...all), hi = Math.max(...all), pad = Math.max(5 - (hi - lo) / 2, (hi - lo) * 0.15); // at least a 10° span, so sensor noise stays flat
      spark.innerHTML = chartSvg({ series, t0, t1, width: 76, height: 22, yMin: lo - pad, yMax: hi + pad, cursor: null, bands: false, axes: false });
    }
  };
  sparks();
  const tick = setInterval(() => { sparks(); if (!panel.hidden && cursor === null) fullCharts(body); }, 1000);
  return () => {
    clearInterval(tick); panel.remove(); rows.removeEventListener("click", onRowClick); rows.classList.remove("pc-tappable");
    rows.querySelectorAll(".pc-spark").forEach((s) => s.remove());
  };
}

// ---- Switcher bar ----

const VARIANTS = [
  { key: "A", name: "Section under the rows", mount: variantA },
  { key: "B", name: "Row sparklines + panel", mount: variantB },
];
let teardown: (() => void) | null = null;

function show(key: string): void {
  const v = VARIANTS.find((x) => x.key === key) ?? VARIANTS[0]!;
  teardown?.();
  teardown = v.mount();
  const url = new URL(location.href);
  url.searchParams.set("variant", v.key);
  history.replaceState(null, "", url);
  bar.querySelector("[data-label]")!.textContent = `${v.key} (${v.name})`;
}

function cycle(delta: number): void {
  const current = new URL(location.href).searchParams.get("variant");
  const i = Math.max(0, VARIANTS.findIndex((v) => v.key === current));
  show(VARIANTS[(i + delta + VARIANTS.length) % VARIANTS.length]!.key);
}

const style = document.createElement("style");
style.textContent = `
.pc-section { margin-top: 18px; }
.pc-head { font-size: 13px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: var(--text-3); }
.pc-body { margin-top: 8px; }
.pc-range { display: flex; gap: 4px; margin-bottom: 10px; }
.pc-range button, .pc-key { font: inherit; font-size: 12px; color: var(--text-2); background: var(--neutral-tint); border: 1px solid var(--neutral-ring); border-radius: 999px; padding: 3px 10px; cursor: pointer; }
.pc-range button[aria-pressed="true"] { color: var(--text); border-color: var(--text-3); }
.pc-title { font-size: 13px; font-weight: 700; color: var(--text); margin: 10px 0 4px; }
.pc-title span { font-weight: 400; color: var(--text-3); }
.pc-plot { touch-action: pan-y; }
.pc-svg { display: block; max-width: 100%; }
.pc-axis { font-size: 9px; fill: var(--text-3); font-family: var(--font-ui); }
.pc-legend { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
.pc-key { display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px; font-size: 11px; }
.pc-key[aria-pressed="false"] { opacity: .45; }
.pc-key--static { cursor: default; background: none; border-color: transparent; }
.pc-key i { width: 10px; height: 3px; border-radius: 2px; display: inline-block; }
.pc-key i.pc-dash { background: repeating-linear-gradient(90deg, var(--text-2) 0 3px, transparent 3px 6px); }
.pc-readout { font-size: 11.5px; color: var(--text-2); margin-top: 4px; min-height: 2.6em; font-variant-numeric: tabular-nums; }
.pc-proto { font-size: 10.5px; color: var(--text-4); margin-top: 6px; }
.pc-spark { order: 1; display: inline-flex; }
.row .row__value { order: 2; } .row .row__target { order: 3; }
.pc-tappable .row { cursor: pointer; }
.pc-panel[hidden] { display: none; }
.pc-panel { position: fixed; inset: 0; z-index: 50; display: flex; align-items: flex-end; justify-content: center; }
.pc-scrim { position: absolute; inset: 0; background: rgba(0,0,0,.5); }
.pc-dialog { position: relative; width: min(480px, 100%); max-height: 88vh; overflow-y: auto; background: var(--bg); border-radius: 20px 20px 0 0; padding: 14px 16px 70px; box-shadow: var(--sheet-shadow); }
@media (min-width: 900px) { .pc-panel { align-items: center; } .pc-dialog { border-radius: 20px; padding-bottom: 20px; } }
.pc-dialog__head { display: flex; align-items: center; justify-content: space-between; }
.pc-close { font: inherit; font-size: 22px; background: none; border: 0; color: var(--text-2); cursor: pointer; }
.pc-bar { position: fixed; left: 50%; bottom: 12px; transform: translateX(-50%); z-index: 60; display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-radius: 999px; background: #ff3d8b; color: #fff; font: 600 13px/1 system-ui, sans-serif; box-shadow: 0 4px 16px rgba(0,0,0,.45); }
.pc-bar button { font: inherit; background: rgba(255,255,255,.2); color: #fff; border: 0; border-radius: 999px; width: 26px; height: 26px; cursor: pointer; }
`;
document.head.append(style);

const bar = document.createElement("div");
bar.className = "pc-bar";
bar.innerHTML = `<button type="button" data-prev aria-label="Previous variant">←</button><span data-label></span><button type="button" data-next aria-label="Next variant">→</button>`;
document.body.append(bar);
bar.querySelector("[data-prev]")!.addEventListener("click", () => cycle(-1));
bar.querySelector("[data-next]")!.addEventListener("click", () => cycle(1));
document.addEventListener("keydown", (e) => {
  const t = e.target as HTMLElement;
  if (t.closest("input, textarea, [contenteditable]")) return;
  if (e.key === "ArrowLeft") cycle(-1);
  if (e.key === "ArrowRight") cycle(1);
});

// New synthetic Reading every 10 s, as the service would push one over SSE.
setInterval(() => readings.push(readingAt(Date.now())), STEP);

// Wait for the dashboard's rows to exist, then mount.
const wait = setInterval(() => {
  if (!document.querySelector(".rows")?.children.length) return;
  clearInterval(wait);
  show(new URL(location.href).searchParams.get("variant") ?? "A");
}, 100);
export {};
