// Dashboard: reads the status snapshot once, then follows the Server-Sent
// Events stream (docs/api.md) and renders every snapshot without a reload.
// It shows the camera through the service's proxy and sends control commands,
// enabling only those the service would accept in the current state.
// The access token, when the service needs one, comes from `?token=` on the
// first visit or from the token form, and is kept in localStorage.
import { type ControlAction, isAllowed } from "../src/control-rules.ts";
import type { CommandResult } from "../src/print-control.ts";
import type { StatusSnapshot, Temperature } from "../src/status-store.ts";
import { delimiterOf, MjpegParser } from "./mjpeg.js";

const TOKEN_KEY = "printer-token";
/** Wait before reopening the event stream after the service closed it. */
const RETRY_MS = 5000;
/** Wait before trying the camera again after it failed. */
const CAMERA_RETRY_MS = 15_000;
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

// ---- Formatting ----

const DASH = "—";

/** "file-checking" → "File checking". */
function label(name: string): string {
  const words = name.replaceAll("-", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function stateLabel(state: { name: string; code: number | null }): string {
  if (state.name !== "unknown") return label(state.name);
  return state.code === null ? DASH : `Unknown (code ${state.code})`;
}

/** Seconds as "1 h 05 min", "4 min 07 s", or "12 s". */
function duration(seconds: number | null): string {
  if (seconds === null) return DASH;
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  if (h > 0) return `${h} h ${String(m).padStart(2, "0")} min`;
  if (m > 0) return `${m} min ${String(rest).padStart(2, "0")} s`;
  return `${rest} s`;
}

function degrees(value: number | null): string {
  return value === null ? DASH : `${value.toFixed(1)} °C`;
}

/** "→ 210 °C", "heater off" for a target of 0, or "" when unknown. */
function target(temperature: Temperature): string {
  if (temperature.target === null) return "";
  return temperature.target === 0 ? "heater off" : `→ ${Math.round(temperature.target)} °C`;
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** "12 s ago", "3 min ago", "2 h ago". */
function age(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  return `${Math.floor(s / 3600)} h ago`;
}

// ---- Rendering ----

/** Whether the event stream to this service is open (false while it reconnects). */
let serviceReachable = false;
let latest: StatusSnapshot | null = null;

function render(): void {
  const snapshot = latest;
  renderConnection(snapshot);
  renderUpdatedAt(snapshot);
  if (snapshot === null) return;

  const name = snapshot.printerName ?? "Printer";
  setText("printerName", name);
  setText("printState", stateLabel(snapshot.printState));
  setText("machineState", stateLabel(snapshot.machineState));
  setText("fileName", snapshot.fileName ?? DASH);
  setText("progress", snapshot.progress === null ? DASH : `${snapshot.progress}%`);
  field<HTMLProgressElement>("progressBar").value = snapshot.progress ?? 0;
  const { current, total } = snapshot.layer;
  setText("layer", current === null || total === null ? DASH : `${current} / ${total}`);
  setText("elapsed", duration(snapshot.elapsed));
  setText("remaining", duration(snapshot.remaining));
  const failed = snapshot.errorCode !== null && snapshot.errorCode !== 0;
  field("errorRow").hidden = !failed;
  setText("errorCode", failed ? String(snapshot.errorCode) : DASH);

  const { nozzle, bed, chamber } = snapshot.temperatures;
  setText("nozzle", degrees(nozzle.current));
  setText("nozzleTarget", target(nozzle));
  setText("bed", degrees(bed.current));
  setText("bedTarget", target(bed));
  setText("chamber", degrees(chamber.current));
  setText("chamberTarget", target(chamber));

  renderControls(snapshot);

  const title = snapshot.progress !== null && snapshot.printState.name === "printing" ? `${snapshot.progress}% · ${name}` : name;
  if (document.title !== title) document.title = title;
}

function renderConnection(snapshot: StatusSnapshot | null): void {
  const badge = field("connection");
  let state: string;
  let text: string;
  if (!serviceReachable) [state, text] = ["unreachable", "Service unreachable"];
  else if (snapshot === null || snapshot.connection === "connecting") [state, text] = ["connecting", "Connecting"];
  else if (snapshot.connection === "online") [state, text] = ["online", "Online"];
  else [state, text] = ["offline", "Offline"];
  badge.dataset.state = state;
  setText("connection", text);

  // No "… ago" here: the notice is a live region, and the footer shows the age.
  const notice = field("offlineNotice");
  const offline = state === "offline" || state === "unreachable";
  notice.hidden = !offline;
  if (!offline) return;
  const what = state === "offline" ? "The printer is offline." : "The service can't be reached.";
  const since = snapshot?.updatedAt == null ? "No status received yet." : `Values are from ${clock(snapshot.updatedAt)}.`;
  setText("offlineNotice", `${what} ${since}`);
}

function renderUpdatedAt(snapshot: StatusSnapshot | null): void {
  const element = field<HTMLTimeElement>("updatedAt");
  const at = snapshot?.updatedAt ?? null;
  if (at === null) {
    setText("updatedAt", "never");
    element.removeAttribute("datetime");
    return;
  }
  element.dateTime = new Date(at).toISOString();
  setText("updatedAt", `${clock(at)} (${age(at, Date.now())})`);
}

// ---- Controls ----

const ACTION_LABELS: Record<ControlAction, string> = { pause: "Pause", resume: "Resume", stop: "Stop", light: "Light" };

/** The command waiting for its result; every button is disabled meanwhile. */
let pending: ControlAction | null = null;

function controlButtons(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>("button[data-action]")];
}

function renderControls(snapshot: StatusSnapshot): void {
  for (const button of controlButtons()) {
    const action = button.dataset.action as ControlAction;
    button.disabled = pending !== null || !serviceReachable || !isAllowed(action, snapshot);
    if (action === "light") {
      const text = snapshot.light === "on" ? "Light off" : snapshot.light === "off" ? "Light on" : "Light";
      if (button.textContent !== text) button.textContent = text;
    }
  }
}

function showMessage(text: string, kind: "info" | "error"): void {
  const element = field("commandMessage");
  element.dataset.kind = kind;
  element.textContent = text;
}

/** One line for a command's result, and whether it is a failure. */
function describeResult(result: CommandResult): [string, "info" | "error"] {
  const name = ACTION_LABELS[result.action];
  switch (result.outcome) {
    case "acknowledged":
      return [`${name}: the printer accepted it.`, "info"];
    case "failed":
      return [`${name} failed: the printer refused it${result.code === null ? "" : ` (code ${result.code})`}.`, "error"];
    case "timeout":
      return [`${name} timed out: the printer didn't answer within 10 seconds.`, "error"];
  }
}

async function sendCommand(action: ControlAction, body: Record<string, unknown>): Promise<void> {
  pending = action;
  render();
  showMessage(`${ACTION_LABELS[action]}: sending…`, "info");
  try {
    const response = await apiFetch("/api/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = (await response.json().catch(() => null)) as { error?: { message?: string } } | CommandResult | null;
    if (response.ok && payload !== null && "outcome" in payload) {
      showMessage(...describeResult(payload));
    } else {
      const reason = (payload !== null && "error" in payload && payload.error?.message) || `HTTP ${response.status}`;
      showMessage(`${ACTION_LABELS[action]} failed: ${reason}.`, "error");
      if (response.status === 401) void connect();
    }
  } catch {
    showMessage(`${ACTION_LABELS[action]} failed: the service can't be reached.`, "error");
  } finally {
    pending = null;
    render();
  }
}

function setUpControls(): void {
  const dialog = view("stopConfirm") as HTMLDialogElement;
  dialog.addEventListener("close", () => {
    if (dialog.returnValue === "stop") void sendCommand("stop", { action: "stop", confirm: true });
  });
  for (const button of controlButtons()) {
    button.addEventListener("click", () => {
      const action = button.dataset.action as ControlAction;
      if (action === "stop") {
        // Stop is sent only from the dialog's "Stop print" button.
        dialog.returnValue = "";
        dialog.showModal();
      } else if (action === "light") {
        void sendCommand("light", { action: "light", on: latest?.light !== "on" });
      } else {
        void sendCommand(action, { action });
      }
    });
  }
}

// ---- Camera ----

/** The open camera stream; aborting it closes the connection. */
let cameraAbort: AbortController | null = null;
let cameraRetryTimer: ReturnType<typeof setTimeout> | undefined;
/** Object URL of the frame on screen, revoked when the next one replaces it. */
let frameUrl: string | null = null;

function setCamera(state: "loading" | "live" | "unavailable" | "paused"): void {
  field("camera").hidden = state !== "live";
  field("cameraPlaceholder").hidden = state === "live";
  field("cameraRetry").hidden = state !== "unavailable";
  const messages = { loading: "Loading camera…", live: "", unavailable: "Camera unavailable", paused: "Camera paused" };
  setText("cameraMessage", messages[state]);
}

function showFrame(frame: Uint8Array): void {
  const image = field<HTMLImageElement>("camera");
  const previous = frameUrl;
  frameUrl = URL.createObjectURL(new Blob([frame as Uint8Array<ArrayBuffer>], { type: "image/jpeg" }));
  image.src = frameUrl;
  if (previous !== null) URL.revokeObjectURL(previous);
}

/**
 * Reads /camera and shows each frame. Resolves when the stream ends or
 * stalls, and rejects when it can't be opened; either way the camera is
 * unavailable until a retry.
 */
async function readCamera(signal: AbortSignal): Promise<void> {
  const response = await apiFetch("/camera", { signal, cache: "no-store" });
  if (!response.ok || response.body === null) throw new Error(`camera answered HTTP ${response.status}`);
  const parser = new MjpegParser(delimiterOf(response.headers.get("content-type")));
  const reader = response.body.getReader();
  let stall: ReturnType<typeof setTimeout> | undefined;
  const armStall = () => {
    clearTimeout(stall);
    stall = setTimeout(() => void reader.cancel(), CAMERA_STALL_MS);
  };
  armStall();
  try {
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
  }
}

function startCamera(): void {
  stopCamera();
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

/** Closes the stream, e.g. while the page is hidden, so it costs the printer nothing. */
function stopCamera(): void {
  clearTimeout(cameraRetryTimer);
  const abort = cameraAbort;
  cameraAbort = null;
  abort?.abort();
  setCamera("paused");
}

function setUpCamera(): void {
  field("cameraRetry").addEventListener("click", startCamera);
  document.addEventListener("visibilitychange", () => (document.hidden ? stopCamera() : startCamera()));
}

// ---- Live updates ----

let events: EventSource | null = null;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

function showTokenForm(message: string): void {
  setText("tokenMessage", message);
  view("token").hidden = false;
  view("dashboard").hidden = true;
}

function showDashboard(): void {
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
    showTokenForm(token === null ? "This service needs its access token." : "That token was not accepted.");
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
  if (!document.hidden) startCamera();

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
  view("token").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = (event.currentTarget as HTMLFormElement).elements.namedItem("token") as HTMLInputElement;
    token = input.value.trim() || null;
    storeToken(token);
    input.value = "";
    void connect();
  });
  setUpControls();
  setUpCamera();
  registerServiceWorker();
  // Keeps the "… ago" texts current between updates.
  setInterval(render, 1000);
  void connect();
}

start();
