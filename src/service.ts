// Wires the service together (design D4): one printer session, the status
// store, print control, the camera proxy, and the HTTP API.
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { CameraProxy } from "./camera-proxy.ts";
import { createApiServer } from "./http-server.ts";
import { PrintControl } from "./print-control.ts";
import { PrinterSession } from "./printer-session.ts";
import { Cmd, type Logger } from "./sdcp-client.ts";
import { StatusStore } from "./status-store.ts";

export interface ServiceOptions {
  /** SDCP WebSocket URL (`sdcpUrl(host)` for a real printer). */
  printerUrl: string;
  /** Camera MJPEG URL (`cameraUrl(host)` for a real printer). */
  cameraUrl: string;
  listen: { host: string; port: number };
  token: string | null;
  logger?: Logger;
}

export interface Service {
  session: PrinterSession;
  store: StatusStore;
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
  const control = new PrintControl(session, store);
  const camera = new CameraProxy({
    url: options.cameraUrl,
    logger,
    // The web UI enables streaming before it shows the camera.
    beforeConnect: () => session.send(Cmd.EDIT_PRINTER_VIDEO_STREAMING, { Enable: 1 }),
  });
  const server = createApiServer({ store, control, token: options.token, camera, logger });
  server.listen(options.listen.port, options.listen.host);
  await once(server, "listening");
  session.start();

  return {
    session,
    store,
    server,
    address: server.address() as AddressInfo,
    async close() {
      camera.close();
      session.stop();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
