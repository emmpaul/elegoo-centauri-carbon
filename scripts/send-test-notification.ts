// Sends one test notification through the configured ntfy server and topic
// (config.json, or NTFY_URL / NTFY_TOPIC), the same way the service sends
// print events, with the same retries. Exits 0 once delivered, 1 when not
// delivered or no topic is configured. It does not contact the printer.
import { loadConfig } from "../src/config.ts";
import { notifierFromConfig } from "../src/notifier.ts";

const config = loadConfig();
const notifier = notifierFromConfig(config);
if (notifier === null) {
  console.error("No ntfy topic configured: set ntfy.topic in config.json or NTFY_TOPIC.");
  process.exit(1);
}
const delivered = await notifier.publish(
  { title: "Test notification", message: "Notifications from your printer service work.", priority: 3, tags: ["tada"] },
  "test notification",
);
if (delivered) console.info(`Test notification sent to ${config.ntfy.url}, topic ${config.ntfy.topic}.`);
process.exit(delivered ? 0 : 1);
