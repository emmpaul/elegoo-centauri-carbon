import { readFileSync } from "node:fs";
import { isIPv4 } from "node:net";

export const EVENT_TYPES = [
  "started",
  "finished",
  "failed",
  "paused",
  "stopped",
  "offline",
  "online",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export interface Config {
  /** Printer address; null means find it with UDP discovery. */
  printerIp: string | null;
  listen: { host: string; port: number };
  /** Access token for the API; null means no token check. */
  token: string | null;
  /** ntfy server and topic; a null topic means no notifications are sent. */
  ntfy: { url: string; topic: string | null };
  events: Record<EventType, boolean>;
}

export function defaultConfig(): Config {
  return {
    printerIp: null,
    listen: { host: "0.0.0.0", port: 8080 },
    token: null,
    ntfy: { url: "https://ntfy.sh", topic: null },
    events: Object.fromEntries(EVENT_TYPES.map((e) => [e, true])) as Record<EventType, boolean>,
  };
}

export interface LoadConfigOptions {
  /** Path of the JSON config file; defaults to CONFIG_PATH, then ./config.json. */
  path?: string;
  env?: Record<string, string | undefined>;
}

/**
 * Builds the config from defaults, then the JSON file (when it exists), then
 * environment variables. An empty environment variable counts as unset.
 */
export function loadConfig(options: LoadConfigOptions = {}): Config {
  const env = options.env ?? process.env;
  const path = options.path ?? nonEmpty(env.CONFIG_PATH) ?? "config.json";
  const config = defaultConfig();

  const file = readJsonFile(path);
  if (file !== undefined) applyFile(config, file, path);
  applyEnv(config, env);
  return config;
}

/**
 * The start-up rule for exposure (design D1): a listen host other than
 * loopback (`localhost`, `::1`, or an IPv4 address in 127.0.0.0/8) needs an
 * access token. Returns the refusal message, or null when the service may start.
 */
export function listenAuthError(listen: { host: string }, token: string | null): string | null {
  if (token !== null || isLoopbackHost(listen.host)) return null;
  return (
    `refusing to listen on ${listen.host} without an access token: ` +
    `set token in the config file or ACCESS_TOKEN, ` +
    `or listen on loopback only with listen.host or LISTEN_HOST set to 127.0.0.1`
  );
}

function isLoopbackHost(host: string): boolean {
  if (host === "localhost" || host === "::1") return true;
  return isIPv4(host) && host.split(".")[0] === "127";
}

function readJsonFile(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${path}: invalid JSON: ${(error as Error).message}`);
  }
}

function applyFile(config: Config, raw: unknown, path: string): void {
  const file = asObject(raw, path);
  if ("printerIp" in file) config.printerIp = nullableString(file.printerIp, `${path}: printerIp`);
  if ("listen" in file) {
    const listen = asObject(file.listen, `${path}: listen`);
    if ("host" in listen) config.listen.host = string(listen.host, `${path}: listen.host`);
    if ("port" in listen) config.listen.port = port(listen.port, `${path}: listen.port`);
  }
  if ("token" in file) config.token = nullableString(file.token, `${path}: token`);
  if ("ntfy" in file) {
    const ntfy = asObject(file.ntfy, `${path}: ntfy`);
    if ("url" in ntfy) config.ntfy.url = string(ntfy.url, `${path}: ntfy.url`);
    if ("topic" in ntfy) config.ntfy.topic = nullableString(ntfy.topic, `${path}: ntfy.topic`);
  }
  if ("events" in file) {
    const events = asObject(file.events, `${path}: events`);
    for (const [name, value] of Object.entries(events)) {
      const event = eventType(name, `${path}: events`);
      if (typeof value !== "boolean") throw new Error(`${path}: events.${name} must be true or false`);
      config.events[event] = value;
    }
  }
}

function applyEnv(config: Config, env: Record<string, string | undefined>): void {
  const printerIp = nonEmpty(env.PRINTER_IP);
  if (printerIp !== undefined) config.printerIp = printerIp;
  const host = nonEmpty(env.LISTEN_HOST);
  if (host !== undefined) config.listen.host = host;
  const listenPort = nonEmpty(env.LISTEN_PORT);
  if (listenPort !== undefined) config.listen.port = port(Number(listenPort), "LISTEN_PORT");
  const token = nonEmpty(env.ACCESS_TOKEN);
  if (token !== undefined) config.token = token;
  const ntfyUrl = nonEmpty(env.NTFY_URL);
  if (ntfyUrl !== undefined) config.ntfy.url = ntfyUrl;
  const ntfyTopic = nonEmpty(env.NTFY_TOPIC);
  if (ntfyTopic !== undefined) config.ntfy.topic = ntfyTopic;
  // NOTIFY_EVENTS lists the enabled events; every other event is turned off.
  // "none" turns all of them off.
  const events = nonEmpty(env.NOTIFY_EVENTS);
  if (events !== undefined) {
    const names = events.trim() === "none" ? [] : events.split(",").map((s) => s.trim()).filter(Boolean);
    const enabled = new Set(names.map((name) => eventType(name, "NOTIFY_EVENTS")));
    for (const event of EVENT_TYPES) config.events[event] = enabled.has(event);
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

function asObject(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${where} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, where: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`${where} must be a non-empty string`);
  return value;
}

function nullableString(value: unknown, where: string): string | null {
  return value === null ? null : string(value, where);
}

function port(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${where} must be a port number from 1 to 65535`);
  }
  return value;
}

function eventType(name: string, where: string): EventType {
  if (!(EVENT_TYPES as readonly string[]).includes(name)) {
    throw new Error(`${where}: unknown event "${name}" (known: ${EVENT_TYPES.join(", ")})`);
  }
  return name as EventType;
}
