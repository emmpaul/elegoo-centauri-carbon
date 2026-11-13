// Wires the service together (design D4): one printer session, the status
// store, the event detector, print control, the camera proxy, and the HTTP
// API with the dashboard.
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { CameraProxy } from "./camera-proxy.ts";
import { dashboardFiles } from "./dashboard-files.ts";
import { EventDetector, type PrintEvent } from "./event-detector.ts";
import { createApiServer } from "./http-server.ts";
import { PrintControl } from "./print-control.ts";
import { PrinterSession } from "./printer-session.ts";
import { Cmd, type Logger } from "./sdcp-client.ts";
import { StatusStore, taskErrorCode } from "./status-store.ts";

export interface ServiceOptions {
  /** SDCP WebSocket URL (`sdcpUrl(host)` for a real printer). */
  printerUrl: string;
  /** Camera MJPEG URL (`cameraUrl(host)` for a real printer). */
  cameraUrl: string;
  listen: { host: string; port: number };
  token: string | null;
  logger?: Logger;
  /** Unreachable time before the "offline" event. 2 minutes by default. */
  offlineAfterMs?: number;
}

export interface Service {
  session: PrinterSession;
  store: StatusStore;
  detector: EventDetector;
  server: Server;
  /** The address the API listens on. */
  address: AddressInfo;
  close(): Promise<void>;
}

/** `http://<host>:3031/video`, the printer's MJPEG camera stream. */
export function cameraUrl(host: string): string {
  return `http://${host}:3031/video`;
}

/** Starts the printer session and the HTTP API; resolves once listening. */
export async function startService(options: ServiceOptions): Promise<Service> {
  const logger = options.logger ?? console;
  const session = new PrinterSession({ url: options.printerUrl, logger });
  const store = new StatusStore();
  store.attach(session);
  const detector = new EventDetector({
    offlineAfterMs: options.offlineAfterMs,
    logger,
    // The end-of-job push carries no error; the task detail has it.
    taskErrorCode: async (taskId) => {
      const response = await session.send(Cmd.GET_PRINTER_TASK_DETAIL, { Id: [taskId] });
      store.applyTaskDetail(response);
      return taskErrorCode(response, taskId) ?? null;
    },
  });
  detector.on("event", (event) => logger.info(`event: ${describeEvent(event)}`));
  detector.attach(store);
  const control = new PrintControl(session, store);
  const camera = new CameraProxy({
    url: options.cameraUrl,
    logger,
    // The web UI enables streaming before it shows the camera.
    beforeConnect: () => session.send(Cmd.EDIT_PRINTER_VIDEO_STREAMING, { Enable: 1 }),
  });
  const server = createApiServer({ store, control, token: options.token, camera, dashboard: dashboardFiles(), logger });
  server.listen(options.listen.port, options.listen.host);
  await once(server, "listening");
  session.start();

  return {
    session,
    store,
    detector,
    server,
    address: server.address() as AddressInfo,
    async close() {
      detector.close();
      camera.close();
      session.stop();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** One-line log form of an event. */
function describeEvent(event: PrintEvent): string {
  const parts: string[] = [event.type];
  if (event.fileName !== null) parts.push(event.fileName);
  if (event.progress !== null) parts.push(`${event.progress}%`);
  if (event.errorCode !== null) parts.push(`error ${event.errorCode}`);
  return parts.join(" ");
}
