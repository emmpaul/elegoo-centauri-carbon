// Preload (`node --import`) for subprocess tests: any attempt to open a UDP
// socket prints a marker to stderr and throws, so a test can tell that
// discovery was attempted without sending anything to the LAN.
import dgram from "node:dgram";
import { syncBuiltinESMExports } from "node:module";

export const UDP_ATTEMPT_MARKER = "no-udp: UDP socket requested";

dgram.createSocket = (() => {
  process.stderr.write(`${UDP_ATTEMPT_MARKER}\n`);
  throw new Error(UDP_ATTEMPT_MARKER);
}) as typeof dgram.createSocket;
syncBuiltinESMExports();
