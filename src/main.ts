// Service entry point: loads the config, finds the printer, and starts the
// service until SIGINT or SIGTERM.
import { listenAuthError, loadConfig } from "./config.ts";
import { resolvePrinterAddress } from "./discovery.ts";
import { notifierFromConfig } from "./notifier.ts";
import { sdcpUrl } from "./sdcp-client.ts";
import { cameraUrl, startService } from "./service.ts";

const config = loadConfig();
// Refuse before discovery, so an exposed start without a token never contacts the printer.
const refusal = listenAuthError(config.listen, config.token);
if (refusal !== null) {
  console.error(refusal);
  process.exit(1);
}
const host = await resolvePrinterAddress({ printerIp: config.printerIp });
const service = await startService({
  printerUrl: sdcpUrl(host),
  cameraUrl: cameraUrl(host),
  listen: config.listen,
  token: config.token,
  notifier: notifierFromConfig(config),
});
console.info(`printer ${host}; API on http://${config.listen.host}:${service.address.port}`);
console.info(config.ntfy.topic === null ? "notifications off (no ntfy topic)" : `notifications to ${config.ntfy.url}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void service.close().then(() => process.exit(0));
  });
}
