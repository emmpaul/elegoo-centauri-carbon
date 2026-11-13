// Health check for the container image: loads the same config as the service
// (config file at CONFIG_PATH, then env such as LISTEN_PORT and ACCESS_TOKEN),
// requests GET /api/status on the listen port with the bearer token when one
// is set, and exits 0 only on a 200 answer within 3 s, 1 otherwise. A wildcard
// listen host (0.0.0.0 or ::) is probed on 127.0.0.1.
import { isIPv6 } from "node:net";
import { loadConfig } from "../src/config.ts";

const TIMEOUT_MS = 3000;

try {
  const config = loadConfig();
  const { host, port } = config.listen;
  const probeHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const urlHost = isIPv6(probeHost) ? `[${probeHost}]` : probeHost;
  const headers: Record<string, string> = {};
  if (config.token !== null) headers.authorization = `Bearer ${config.token}`;
  const response = await fetch(`http://${urlHost}:${port}/api/status`, {
    headers,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  await response.body?.cancel();
  if (response.status !== 200) {
    console.error(`unhealthy: /api/status answered ${response.status}`);
    process.exit(1);
  }
  process.exit(0);
} catch (error) {
  console.error(`unhealthy: ${(error as Error).message}`);
  process.exit(1);
}
