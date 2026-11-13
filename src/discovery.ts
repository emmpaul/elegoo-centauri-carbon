import { createSocket } from "node:dgram";

/** UDP port the printer listens on for the discovery probe. */
export const DISCOVERY_PORT = 3000;
/** Probe text the printer answers with its identity. */
export const DISCOVERY_PROBE = "M99999";

export interface DiscoveredPrinter {
  /** Envelope `Id` of the reply. */
  id: string;
  name: string;
  ip: string;
  mainboardId: string;
  protocolVersion: string;
  firmwareVersion: string;
}

/**
 * Parses one discovery reply. Accepts the `{Id, Data: {...}}` envelope or the
 * same fields at the top level. Returns null when the reply is not JSON or
 * lacks the mainboard id. A missing `MainboardIP` falls back to the sender
 * address.
 */
export function parseDiscoveryReply(text: string, senderIp: string): DiscoveredPrinter | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(raw)) return null;
  const data = isObject(raw.Data) ? raw.Data : raw;
  const mainboardId = str(data.MainboardID);
  if (mainboardId === "") return null;
  return {
    id: str(raw.Id),
    name: str(data.Name) || str(data.MachineName),
    ip: str(data.MainboardIP) || senderIp,
    mainboardId,
    protocolVersion: str(data.ProtocolVersion),
    firmwareVersion: str(data.FirmwareVersion),
  };
}

export interface DiscoverOptions {
  /** How long to collect replies, in milliseconds. */
  timeoutMs?: number;
  /** Probe target; the broadcast address by default. */
  address?: string;
  port?: number;
}

/** Broadcasts the discovery probe and collects replies until the timeout. */
export function discover(options: DiscoverOptions = {}): Promise<DiscoveredPrinter[]> {
  const timeoutMs = options.timeoutMs ?? 2000;
  const address = options.address ?? "255.255.255.255";
  const port = options.port ?? DISCOVERY_PORT;
  return new Promise((resolve, reject) => {
    const socket = createSocket({ type: "udp4", reuseAddr: true });
    const found = new Map<string, DiscoveredPrinter>();
    let timer: NodeJS.Timeout | undefined;
    const finish = (error?: Error) => {
      if (timer !== undefined) clearTimeout(timer);
      socket.close();
      if (error) reject(error);
      else resolve([...found.values()]);
    };
    socket.on("error", (error) => finish(error));
    socket.on("message", (msg, rinfo) => {
      const printer = parseDiscoveryReply(msg.toString("utf8"), rinfo.address);
      if (printer) found.set(printer.mainboardId, printer);
    });
    socket.bind(0, () => {
      socket.setBroadcast(true);
      socket.send(DISCOVERY_PROBE, port, address, (error) => {
        if (error) finish(error);
        else timer = setTimeout(() => finish(), timeoutMs);
      });
    });
  });
}

export interface ResolvePrinterOptions {
  /** The configured printer address; null means discover. */
  printerIp: string | null;
  /** Discovery function; replaceable in tests. */
  discover?: () => Promise<DiscoveredPrinter[]>;
}

/**
 * Returns the address to connect to. A configured address wins and skips
 * discovery entirely; otherwise the first printer that answers is used.
 */
export async function resolvePrinterAddress(options: ResolvePrinterOptions): Promise<string> {
  if (options.printerIp !== null) return options.printerIp;
  const printers = await (options.discover ?? (() => discover()))();
  const first = printers[0];
  if (first === undefined) throw new Error("no printer answered UDP discovery; set printerIp in the config");
  return first.ip;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}
