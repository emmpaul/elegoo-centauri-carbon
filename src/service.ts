// Wires the service together (design D4): one printer session, the status
// store, the event detector, print control, the camera proxy, the history
// archive and its sync, and the HTTP API with the dashboard.
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { CameraProxy } from "./camera-proxy.ts";
import { listenAuthError } from "./config.ts";
import { dashboardFiles } from "./dashboard-files.ts";
import { EventDetector, isJobActive, type PrintEvent } from "./event-detector.ts";
import { HistoryStore } from "./history-store.ts";
import { HistorySync } from "./history-sync.ts";
import { createApiServer, type HistorySource } from "./http-server.ts";
import type { Notifier } from "./notifier.ts";
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
  /** Push channel for events; none means events are only logged. */
  notifier?: Notifier | null;
  /** History archive file; `:memory:` (kept only while running) by default. */
  historyPath?: string;
}

export interface Service {
  session: PrinterSession;
  store: StatusStore;
  detector: EventDetector;
  /** The print history archive. */
  history: HistoryStore;
  server: Server;
  /** The address the API listens on. */
  address: AddressInfo;
  close(): Promise<void>;
}

/** `http://<host>:3031/video`, the printer's MJPEG camera stream. */
export function cameraUrl(host: string): string {
  return `http://${host}:3031/video`;
}

/**
 * Starts the printer session and the HTTP API; resolves once listening.
 * Rejects before opening any socket when the listen host is not loopback
 * and no token is set.
 */
export async function startService(options: ServiceOptions): Promise<Service> {
  // Checked here too, not only in main.ts, so no caller can start the service exposed without a token.
  const refusal = listenAuthError(options.listen, options.token);
  if (refusal !== null) throw new Error(refusal);
  const logger = options.logger ?? console;
  // Opened first, so an archive that cannot be opened leaves no socket open.
  const history = HistoryStore.open(options.historyPath ?? ":memory:");
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
  const historySync = new HistorySync({
    session,
    store: history,
    printerHost: new URL(options.printerUrl).hostname,
    logger,
    printActive: () => isJobActive(store.snapshot),
  });
  session.on("state", (state) => {
    if (state === "online") historySync.trigger();
  });
  detector.on("event", (event) => {
    if (event.type === "finished" || event.type === "failed" || event.type === "stopped") historySync.trigger();
  });
  const notifier = options.notifier ?? null;
  detector.on("event", (event) => {
    logger.info(`event: ${describeEvent(event)}`);
    // Delivery runs on its own: its retries and failures never wait on or touch the session.
    if (notifier !== null) void notifier.notify(event).catch((error: Error) => logger.error(`notification failed: ${error.message}`));
  });
  detector.attach(store);
  const control = new PrintControl(session, store);
  const camera = new CameraProxy({
    url: options.cameraUrl,
    logger,
    // The web UI enables streaming before it shows the camera.
    beforeConnect: () => session.send(Cmd.EDIT_PRINTER_VIDEO_STREAMING, { Enable: 1 }),
  });
  const historySource: HistorySource = {
    list: (before, limit) => history.list(before, limit),
    thumbnail: (taskId) => history.thumbnail(taskId),
    on: (event, listener) => historySync.on(event, listener),
    off: (event, listener) => historySync.off(event, listener),
  };
  const server = createApiServer({
    store,
    control,
    token: options.token,
    camera,
    history: historySource,
    dashboard: dashboardFiles(),
    logger,
  });
  server.listen(options.listen.port, options.listen.host);
  try {
    await once(server, "listening");
  } catch (error) {
    historySync.close();
    history.close();
    throw error;
  }
  session.start();

  return {
    session,
    store,
    detector,
    history,
    server,
    address: server.address() as AddressInfo,
    async close() {
      detector.close();
      camera.close();
      historySync.close();
      session.stop();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      history.close();
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
