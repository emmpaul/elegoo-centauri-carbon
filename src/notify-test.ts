// The test notification (`pnpm notify:test`, design D7): one Notification
// through the configured ntfy server and topic, the same way the service
// sends print events, with the same retries. With photos off it never
// contacts the printer. With photos on it opens its own printer session and
// camera proxy, takes one Photo without the Photo light (it never sends a
// light command), and reports whether the Photo went out or why not.
import { CameraProxy } from "./camera-proxy.ts";
import type { Config } from "./config.ts";
import { type PhotoResult, PhotoTaker } from "./notification-photo.ts";
import { notifierFromConfig, type PushMessage } from "./notifier.ts";
import { PrinterSession } from "./printer-session.ts";
import { Cmd, type Logger } from "./sdcp-client.ts";

const TEST_MESSAGE: PushMessage = {
  title: "Test notification",
  message: "Notifications from your printer service work.",
  priority: 3,
  tags: ["tada"],
};

/** The longest wait for the printer session to come online. */
const ONLINE_WAIT_MS = 5_000;

export interface TestNotificationOptions {
  config: Pick<Config, "ntfy" | "events">;
  /** SDCP WebSocket URL; used only with photos on. */
  printerUrl?: string;
  /** Camera MJPEG URL; used only with photos on. */
  cameraUrl?: string;
  logger?: Logger;
}

/**
 * Sends the test Notification and logs where it went, with a photo or
 * without one and why. Resolves true once delivered; false when not
 * delivered or no topic is configured. Never rejects.
 */
export async function sendTestNotification(options: TestNotificationOptions): Promise<boolean> {
  const { config } = options;
  const logger = options.logger ?? console;
  const notifier = notifierFromConfig(config, logger);
  if (notifier === null) {
    logger.error("No ntfy topic configured: set ntfy.topic in config.json or NTFY_TOPIC.");
    return false;
  }
  const sentTo = `Test notification sent to ${config.ntfy.url}, topic ${config.ntfy.topic}`;
  if (!config.ntfy.photos) {
    const delivered = await notifier.publish(TEST_MESSAGE, "test notification");
    if (delivered) logger.info(`${sentTo}.`);
    return delivered;
  }
  const photo = await takeTestPhoto(options.printerUrl, options.cameraUrl, logger);
  const delivery = await notifier.deliver(TEST_MESSAGE, "test", photo);
  if (delivery.delivered) {
    logger.info(delivery.photo ? `${sentTo}, with a photo.` : `${sentTo}, without a photo: ${delivery.fallback}.`);
  }
  return delivery.delivered;
}

/** One Photo through a private session and camera proxy, closed again afterwards. */
async function takeTestPhoto(printerUrl: string | undefined, cameraUrl: string | undefined, logger: Logger): Promise<PhotoResult> {
  if (printerUrl === undefined || cameraUrl === undefined) return { jpeg: null, reason: "no printer address" };
  const session = new PrinterSession({ url: printerUrl, logger });
  session.start();
  try {
    if (!(await online(session, ONLINE_WAIT_MS))) {
      return { jpeg: null, reason: `printer not online within ${ONLINE_WAIT_MS / 1000} s` };
    }
    const camera = new CameraProxy({
      url: cameraUrl,
      logger,
      // The web UI enables streaming before it shows the camera.
      beforeConnect: () => session.send(Cmd.EDIT_PRINTER_VIDEO_STREAMING, { Enable: 1 }),
    });
    try {
      return await new PhotoTaker({ camera, light: null, logger }).take();
    } finally {
      camera.close();
    }
  } finally {
    session.stop();
  }
}

/** Resolves true once the session is online, false after `ms` without it. */
function online(session: PrinterSession, ms: number): Promise<boolean> {
  if (session.state === "online") return Promise.resolve(true);
  return new Promise((resolve) => {
    const onState = (state: string) => {
      if (state !== "online") return;
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      session.off("state", onState);
      resolve(false);
    }, ms);
    session.on("state", onState);
  });
}
