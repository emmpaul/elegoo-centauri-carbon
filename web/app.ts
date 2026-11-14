// Dashboard: reads the status snapshot once, then follows the Server-Sent
// Events stream (docs/api.md) and renders every snapshot without a reload.
// It shows the camera through the service's proxy and sends control commands,
// enabling only those the service would accept in the current state.
// The access token, when the service needs one, comes from `?token=` on the
// first visit or from the token screen, and is kept in localStorage.
import type { ControlAction } from "../src/control-rules.ts";
import type { CommandResult } from "../src/print-control.ts";
import type { StatusSnapshot } from "../src/status-store.ts";
import { delimiterOf, MjpegParser } from "./mjpeg.js";
import { ACK_CLEAR_MS, type ButtonView, type CommandState, type DashboardView, dashboardView, type Row, settleSlide, type SlideState, type SlideView, type StatusView, type TokenPageState, tokenView } from "./view.js";
import { attachStopSlide } from "./stop-slide.js";

const TOKEN_KEY = "printer-token";
/** Wait before reopening the event stream after the service closed it. */
const RETRY_MS = 5000;
/** Wait before trying the camera again after it failed (design D11). */
const CAMERA_RETRY_MS = 10_000;
/** A camera stream that sends no frame for this long counts as failed. */
const CAMERA_STALL_MS = 10_000;

// ---- Access token ----

function storedToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function storeToken(token: string | null): void {
  try {
    if (token === null) localStorage.removeItem(TOKEN_KEY);
    else localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Storage blocked: the token lasts for this page only.
  }
}

let token: string | null = storedToken();

/** Takes `?token=` from the address bar into storage and removes it from the visible URL. */
function adoptTokenFromUrl(): void {
  const url = new URL(location.href);
  const given = url.searchParams.get("token");
  if (given === null) return;
  token = given;
  storeToken(given);
  url.searchParams.delete("token");
  history.replaceState(null, "", url);
}

/** `path` with the token as a query parameter, for EventSource and <img>. */
function withToken(path: string): string {
  if (token === null) return path;
  const url = new URL(path, location.href);
  url.searchParams.set("token", token);
  return url.pathname + url.search;
}

/** Fetch with the token as a bearer header. */
function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (token !== null) headers.set("Authorization", `Bearer ${token}`);
  return fetch(path, { ...init, headers });
}

// ---- DOM helpers ----

function field<T extends HTMLElement = HTMLElement>(name: string): T {
  const element = document.querySelector<T>(`[data-field="${name}"]`);
  if (element === null) throw new Error(`missing [data-field="${name}"]`);
  return element;
}

function view(name: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-view="${name}"]`);
  if (element === null) throw new Error(`missing [data-view="${name}"]`);
  return element;
}

function setText(name: string, text: string): void {
  const element = field(name);
  if (element.textContent !== text) element.textContent = text;
}

// ---- Rendering ----

/** Whether the event stream to this service is open (false while it reconnects). */
let serviceReachable = false;
let latest: StatusSnapshot | null = null;

function render(): void {
  const snapshot = latest;
  const thumb = field<HTMLButtonElement>("slideThumb");
  let dashboard = dashboardView(snapshot, { streamOpen: serviceReachable, command, slide }, Date.now());
  // A disabled or released, unfocused slide drops its progress (it never carries to a later stop).
  if (settleSlide(slide, !dashboard.slide.disabled, slide.dragging || document.activeElement === thumb)) {
    dashboard = dashboardView(snapshot, { streamOpen: serviceReachable, command, slide }, Date.now());
  }
  const status = dashboard.status;
  renderHeader(status.printerName, status.online);
  updateCamera(status.online);
  renderStatus(status);
  renderControls(dashboard);

  const name = status.printerName;
  const title = snapshot !== null && snapshot.progress !== null && snapshot.printState.name === "printing" ? `${snapshot.progress}% · ${name}` : name;
  if (document.title !== title) document.title = title;
}

/** Header: the printer's name and the Online/Offline mark (design D7, D9). */
function renderHeader(name: string, online: boolean): void {
  setText("printerName", name);
  field("online").hidden = !online;
  field("offline").hidden = online;
}

function setAttr(element: HTMLElement, name: string, value: string | null): void {
  if (value === null) element.removeAttribute(name);
  else if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

/** The status sheet above the controls, written from the view model. */
function renderStatus(status: StatusView): void {
  const dash = view("dashboard");
  setAttr(dash, "data-tone", status.tone);
  setAttr(dash, "data-stale", status.online ? null : "");

  field("banner").hidden = status.banner === null;
  if (status.banner !== null) {
    setText("bannerStrong", status.banner.strong);
    setText("bannerRest", status.banner.rest);
  }

  setAttr(field("glyph"), "data-glyph", status.glyph);
  setText("stateLabel", status.stateLabel);
  const hasFile = status.fileName !== null;
  field("fileSlash").hidden = !hasFile;
  field("fileName").hidden = !hasFile;
  field("fileSpacer").hidden = hasFile;
  setText("fileName", status.fileName ?? "");
  field("updateClock").hidden = status.updateClock === null;
  setText("updateClock", status.updateClock ?? "");

  setText("headlineBig", status.headline.big);
  setText("headlinePct", status.headline.pct);
  setText("subLine", status.headline.sub);
  const ticks = field("ticks");
  setAttr(ticks, "aria-valuenow", String(status.ticks.pct));
  setAttr(ticks, "data-glow", status.ticks.glow ? "" : null);
  field("ticksFill").style.width = status.ticks.width;

  field("error").hidden = status.error === null;
  setText("errorTitle", status.error?.title ?? "");
  setText("errorText", status.error?.text ?? "");
  field("note").hidden = status.note === null;
  setText("note", status.note ?? "");

  renderRows(status.rows);
}

function renderRows(rows: Row[]): void {
  const container = field("rows");
  while (container.children.length > rows.length) container.lastElementChild?.remove();
  while (container.children.length < rows.length) {
    const row = document.createElement("div");
    row.className = "row";
    for (const part of ["row__key", "row__value", "row__target"]) {
      const span = document.createElement("span");
      span.className = part;
      row.append(span);
    }
    container.append(row);
  }
  rows.forEach((row, index) => {
    const cells = container.children[index]!.children;
    [row.key, row.value, row.target].forEach((text, cell) => {
      const element = cells[cell]!;
      if (element.textContent !== text) element.textContent = text;
    });
  });
}

// ---- Controls and message slot (design D8) ----

/** The page aborts a command request after this long and shows it as timed out (the service's own limit is 10 s). */
const COMMAND_ABORT_MS = 15_000;

/** The command in flight or last answered; one at a time. */
let command: CommandState | null = null;
/** The request body of `command`, re-sent by Retry. */
let commandBody: Record<string, unknown> | null = null;
let ackTimer: ReturnType<typeof setTimeout> | undefined;
/** The stop thumb (design D12). */
const slide: SlideState = { x: 0, dragging: false, max: 0 };

function controlButton(action: ControlAction): HTMLButtonElement {
  const element = document.querySelector<HTMLButtonElement>(`button[data-action="${action}"]`);
  if (element === null) throw new Error(`missing button[data-action="${action}"]`);
  return element;
}

function renderButton(action: "light" | "pause" | "resume", button: ButtonView): void {
  const element = controlButton(action);
  element.disabled = button.disabled;
  setAttr(element, "data-look", button.look);
  setText(`${action}Label`, button.label);
}

function renderControls(dashboard: DashboardView): void {
  const { message, light } = dashboard;
  const slot = field("message");
  slot.hidden = message === null;
  if (message !== null) {
    setAttr(slot, "data-tone", message.tone);
    setAttr(slot, "data-retry", message.retry ? "" : null);
    setAttr(field("messageMark"), "data-mark", message.mark);
    setText("messageTitle", message.title);
    setText("messageSub", message.sub);
    field("messageRetry").hidden = !message.retry;
    field("messageDismiss").hidden = !message.retry;
    field("messageBar").hidden = !message.pending;
  }

  renderButton("light", light);
  setAttr(controlButton("light"), "aria-pressed", String(light.pressed));
  setAttr(field("lightDot"), "data-dot", light.dot);
  renderButton("pause", dashboard.pause);
  renderButton("resume", dashboard.resume);
  renderSlide(dashboard.slide);
}

/** The stop slide's track, thumb, fill, and label (design D12). */
function renderSlide(view: SlideView): void {
  field("slidePending").hidden = !view.pending;
  const track = field("slide");
  track.hidden = view.pending;
  setAttr(track, "data-look", view.look);
  setAttr(track, "data-dragging", view.animate ? null : "");
  const thumb = field<HTMLButtonElement>("slideThumb");
  thumb.disabled = view.disabled;
  setAttr(thumb, "aria-valuenow", String(view.pct));
  thumb.style.left = view.thumbLeft;
  field("slideFill").style.width = view.fillWidth;
  const label = field("slideLabel");
  setText("slideLabel", view.label);
  setAttr(label, "data-ink", view.labelInk);
  label.style.left = view.labelLeft;
  label.style.right = view.labelRight;
  label.style.paddingLeft = view.labelPadLeft;
}

function setCommand(next: CommandState | null): void {
  clearTimeout(ackTimer);
  command = next;
  if (next !== null && next.status === "ack") {
    ackTimer = setTimeout(() => {
      if (command === next) setCommand(null);
    }, ACK_CLEAR_MS);
  }
  render();
}

/** The service's error message as a sentence for the sub-line. */
function reasonOf(payload: unknown, status: number): string {
  const message = (payload as { error?: { message?: unknown } } | null)?.error?.message;
  const text = typeof message === "string" && message !== "" ? message : `the service answered HTTP ${status}`;
  return `${text[0]!.toUpperCase()}${text.slice(1)}.`;
}

/** Sends one command and follows it through pending to its outcome; ignored while another is in flight. */
async function sendCommand(action: ControlAction, body: Record<string, unknown>): Promise<void> {
  if (command?.status === "pending") return;
  commandBody = body;
  setCommand({ action, status: "pending" });
  const abort = new AbortController();
  const safety = setTimeout(() => abort.abort(), COMMAND_ABORT_MS);
  try {
    const response = await apiFetch("/api/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: abort.signal,
    });
    const payload = (await response.json().catch(() => null)) as unknown;
    if (response.ok && payload !== null && typeof payload === "object" && "outcome" in payload) {
      const result = payload as CommandResult;
      if (result.outcome === "acknowledged") setCommand({ action, status: "ack" });
      else if (result.outcome === "failed") setCommand({ action, status: "failed", code: result.code });
      else setCommand({ action, status: "timeout" });
    } else {
      setCommand({ action, status: "failed", code: null, reason: reasonOf(payload, response.status) });
      if (response.status === 401) void connect();
    }
  } catch {
    if (abort.signal.aborted) setCommand({ action, status: "timeout" });
    else setCommand({ action, status: "failed", code: null, reason: "The service can’t be reached." });
  } finally {
    clearTimeout(safety);
  }
}

function setUpControls(): void {
  // Stop is sent only from the slide, dragged to its end or completed from the keyboard.
  attachStopSlide(field("slide"), field<HTMLButtonElement>("slideThumb"), {
    slide,
    enabled: () => !field<HTMLButtonElement>("slideThumb").disabled,
    changed: render,
    stop: () => void sendCommand("stop", { action: "stop", confirm: true }),
  });
  controlButton("light").addEventListener("click", () => void sendCommand("light", { action: "light", on: latest?.light !== "on" }));
  controlButton("pause").addEventListener("click", () => void sendCommand("pause", { action: "pause" }));
  controlButton("resume").addEventListener("click", () => void sendCommand("resume", { action: "resume" }));
  field("messageRetry").addEventListener("click", () => {
    if (command === null || commandBody === null) return;
    const { action } = command;
    setCommand(null);
    void sendCommand(action, commandBody);
  });
  field("messageDismiss").addEventListener("click", () => setCommand(null));
}

// ---- Camera (design D11) ----

type CameraState = "loading" | "live" | "unavailable" | "offline";

/** The open camera stream; aborting it closes the connection. */
let cameraAbort: AbortController | null = null;
let cameraRetryTimer: ReturnType<typeof setTimeout> | undefined;
/** Object URL of the frame on screen, revoked when the next one replaces it. */
let frameUrl: string | null = null;
/** Whether the stream should be open: the printer is online and the page visible. */
let cameraWanted = false;

const CAMERA_TEXT: Record<CameraState, [title: string, sub: string]> = {
  loading: ["", ""],
  live: ["", ""],
  unavailable: ["Camera unavailable", "Stream didn’t load. Status still live."],
  offline: ["Camera offline", "Returns with the printer."],
};

function setCamera(state: CameraState): void {
  field("camera").dataset.cam = state;
  field("cameraImage").hidden = state !== "live";
  field("cameraRetry").hidden = state !== "unavailable";
  const [title, sub] = CAMERA_TEXT[state];
  setText("cameraTitle", title);
  setText("cameraSub", sub);
}

function showFrame(frame: Uint8Array): void {
  const image = field<HTMLImageElement>("cameraImage");
  const previous = frameUrl;
  frameUrl = URL.createObjectURL(new Blob([frame as Uint8Array<ArrayBuffer>], { type: "image/jpeg" }));
  image.src = frameUrl;
  if (previous !== null) URL.revokeObjectURL(previous);
}

/**
 * Reads /camera and shows each frame. Resolves when the stream ends, and
 * rejects when it can't be opened or sends no frame for CAMERA_STALL_MS
 * (counted from the request, so a camera that never answers fails too);
 * either way the camera is unavailable until a retry.
 */
async function readCamera(signal: AbortSignal): Promise<void> {
  const stalled = new AbortController();
  const stop = () => stalled.abort();
  signal.addEventListener("abort", stop, { once: true });
  let stall: ReturnType<typeof setTimeout> | undefined;
  const armStall = () => {
    clearTimeout(stall);
    stall = setTimeout(stop, CAMERA_STALL_MS);
  };
  armStall();
  try {
    const response = await apiFetch("/camera", { signal: stalled.signal, cache: "no-store" });
    if (!response.ok || response.body === null) throw new Error(`camera answered HTTP ${response.status}`);
    const parser = new MjpegParser(delimiterOf(response.headers.get("content-type")));
    const reader = response.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      const frames = parser.push(value);
      const last = frames.at(-1);
      if (last === undefined) continue;
      armStall();
      showFrame(last);
      setCamera("live");
    }
  } finally {
    clearTimeout(stall);
    signal.removeEventListener("abort", stop);
  }
}

function startCamera(): void {
  closeCamera();
  const abort = new AbortController();
  cameraAbort = abort;
  setCamera("loading");
  readCamera(abort.signal)
    .catch(() => undefined)
    .then(() => {
      if (cameraAbort !== abort) return; // stopped or restarted meanwhile
      cameraAbort = null;
      setCamera("unavailable");
      cameraRetryTimer = setTimeout(startCamera, CAMERA_RETRY_MS);
    });
}

/** Closes the stream and stops retrying. */
function closeCamera(): void {
  clearTimeout(cameraRetryTimer);
  const abort = cameraAbort;
  cameraAbort = null;
  abort?.abort();
}

/**
 * Opens the stream while the printer is online and the page visible, and
 * closes it otherwise, so a hidden page or an offline printer costs nothing.
 * Offline shows "Camera offline" (no Retry) until the printer is back.
 */
function updateCamera(online: boolean): void {
  const want = online && !document.hidden;
  if (!online) {
    const state: CameraState = latest === null ? "loading" : "offline";
    if (field("camera").dataset.cam !== state) setCamera(state);
  }
  if (want === cameraWanted) return;
  cameraWanted = want;
  if (want) startCamera();
  else closeCamera();
}

function setUpCamera(): void {
  field("cameraRetry").addEventListener("click", startCamera);
  document.addEventListener("visibilitychange", render);
}

// ---- Theme (design D4) ----

type Theme = "dark" | "light";
const THEME_COLOR: Record<Theme, string> = { dark: "#0f0f0f", light: "#f3f3f1" };
const prefersLight = matchMedia("(prefers-color-scheme: light)");

/** The stored choice (applied by /theme.js as `data-theme`), else the system preference. */
function themeInEffect(): Theme {
  const chosen = document.documentElement.dataset.theme;
  if (chosen === "dark" || chosen === "light") return chosen;
  return prefersLight.matches ? "light" : "dark";
}

function renderTheme(): void {
  const theme = themeInEffect();
  const label = theme === "dark" ? "Switch to light theme" : "Switch to dark theme";
  const toggle = field("themeToggle");
  toggle.setAttribute("aria-label", label);
  toggle.title = label;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLOR[theme]);
}

/** The toggle stores the opposite of the theme in effect, so it is remembered on this device. */
function setUpTheme(): void {
  field("themeToggle").addEventListener("click", () => {
    const next: Theme = themeInEffect() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("theme", next);
    } catch {
      // Storage blocked: the choice lasts for this page only.
    }
    renderTheme();
  });
  prefersLight.addEventListener("change", renderTheme);
  renderTheme();
}

// ---- Live updates ----

let events: EventSource | null = null;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

const tokenPage: TokenPageState = { rejected: false, edited: false, shown: false };

/** The token screen from its page state (the component's token variants). */
function renderToken(): void {
  const look = tokenView(tokenPage);
  setText("tokenTitle", look.title);
  setText("tokenBody", look.body);
  const input = field<HTMLInputElement>("tokenInput");
  if (input.type !== look.inputType) input.type = look.inputType;
  setAttr(input, "aria-invalid", String(look.error));
  setAttr(input, "aria-describedby", look.error ? "token-error" : null);
  field("tokenError").hidden = !look.error;
  setText("tokenShow", look.showLabel);
}

/**
 * Shows the token screen after a 401: empty on first run, or with the
 * rejected token kept in the field so it can be corrected.
 */
function showTokenScreen(): void {
  tokenPage.rejected = token !== null;
  tokenPage.edited = false;
  field<HTMLInputElement>("tokenInput").value = token ?? "";
  renderToken();
  view("token").hidden = false;
  view("dashboard").hidden = true;
}

function setUpTokenScreen(): void {
  const input = field<HTMLInputElement>("tokenInput");
  input.addEventListener("input", () => {
    tokenPage.edited = true;
    renderToken();
  });
  field("tokenShow").addEventListener("click", () => {
    tokenPage.shown = !tokenPage.shown;
    renderToken();
  });
  field("tokenForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const given = input.value.trim();
    if (given === "") return;
    token = given;
    storeToken(token);
    void connect();
  });
}

function showDashboard(): void {
  field<HTMLInputElement>("tokenInput").value = "";
  view("token").hidden = true;
  view("dashboard").hidden = false;
}

function scheduleConnect(): void {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => void connect(), RETRY_MS);
}

/** Checks the token with one status read, then follows the event stream. */
async function connect(): Promise<void> {
  events?.close();
  events = null;
  let response: Response;
  try {
    response = await apiFetch("/api/status");
  } catch {
    serviceReachable = false;
    render();
    scheduleConnect();
    return;
  }
  if (response.status === 401) {
    serviceReachable = true;
    render();
    showTokenScreen();
    return;
  }
  if (!response.ok) {
    serviceReachable = false;
    render();
    scheduleConnect();
    return;
  }
  showDashboard();
  serviceReachable = true;
  latest = (await response.json()) as StatusSnapshot;
  render();

  const source = new EventSource(withToken("/api/events"));
  events = source;
  source.addEventListener("status", (event) => {
    serviceReachable = true;
    latest = JSON.parse((event as MessageEvent<string>).data) as StatusSnapshot;
    render();
  });
  source.addEventListener("open", () => {
    serviceReachable = true;
    render();
  });
  source.addEventListener("error", () => {
    if (events !== source) return;
    serviceReachable = false;
    render();
    // EventSource retries by itself while CONNECTING; once CLOSED (an error
    // answer such as 401 or 503), start over, which re-checks the token.
    if (source.readyState === EventSource.CLOSED) scheduleConnect();
  });
}

/**
 * Registers the service worker that makes the page installable. Browsers
 * allow it only in a secure context (HTTPS, or localhost); elsewhere the
 * page works the same without it.
 */
function registerServiceWorker(): void {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("/sw.js").catch((error: unknown) => console.warn("service worker not registered:", error));
}

function start(): void {
  adoptTokenFromUrl();
  setUpTokenScreen();
  setUpTheme();
  setUpControls();
  setUpCamera();
  registerServiceWorker();
  // Keeps the "… ago" texts current between updates.
  setInterval(render, 1000);
  void connect();
}

start();
