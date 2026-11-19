// Sends one test notification through the configured ntfy server and topic
// (config.json, or NTFY_URL / NTFY_TOPIC), the same way the service sends
// print events, with the same retries (src/notify-test.ts). With photos on it
// finds the printer (printerIp, else discovery) and attaches a Photo from
// its camera; with photos off it does not contact the printer. Exits 0 once
// delivered, 1 when not delivered or no topic is configured.
import { loadConfig } from "../src/config.ts";
import { resolvePrinterAddress } from "../src/discovery.ts";
import { sendTestNotification } from "../src/notify-test.ts";
import { sdcpUrl } from "../src/sdcp-client.ts";
import { cameraUrl } from "../src/service.ts";

const config = loadConfig();
let host: string | undefined;
if (config.ntfy.photos && config.ntfy.topic !== null) {
  try {
    host = await resolvePrinterAddress({ printerIp: config.printerIp });
  } catch (error) {
    // No printer means no Photo, not a failed test: the Notification still goes out text-only.
    console.warn((error as Error).message);
  }
}
const delivered = await sendTestNotification({
  config,
  printerUrl: host === undefined ? undefined : sdcpUrl(host),
  cameraUrl: host === undefined ? undefined : cameraUrl(host),
});
process.exit(delivered ? 0 : 1);
