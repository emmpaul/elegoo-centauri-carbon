// Service entry point: loads the config, finds the printer, and starts the
// service until SIGINT or SIGTERM.
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { listenAuthError, loadConfig } from "./config.ts";
import { resolvePrinterAddress } from "./discovery.ts";
import { notifierFromConfig } from "./notifier.ts";
import { sdcpUrl } from "./sdcp-client.ts";
import { cameraUrl, type Service, startService } from "./service.ts";

const config = loadConfig();
// Refuse before discovery, so an exposed start without a token never contacts the printer.
const refusal = listenAuthError(config.listen, config.token);
if (refusal !== null) {
  console.error(refusal);
  process.exit(1);
}
const dataDir = resolve(config.dataDir);
try {
  mkdirSync(dataDir, { recursive: true });
} catch (error) {
  console.error(
    `cannot create the data directory ${dataDir} (set DATA_DIR or dataDir to a writable directory): ${(error as Error).message}`,
  );
  process.exit(1);
}
const host = await resolvePrinterAddress({ printerIp: config.printerIp });
let service: Service;
try {
  service = await startService({
    printerUrl: sdcpUrl(host),
    cameraUrl: cameraUrl(host),
    listen: config.listen,
    token: config.token,
    notifier: notifierFromConfig(config),
    historyPath: join(dataDir, "history.sqlite"),
  });
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
console.info(`printer ${host}; API on http://${config.listen.host}:${service.address.port}`);
console.info(config.ntfy.topic === null ? "notifications off (no ntfy topic)" : `notifications to ${config.ntfy.url}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void service.close().then(() => process.exit(0));
  });
}
