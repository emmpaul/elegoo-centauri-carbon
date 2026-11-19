// Runs only the fake printer and a fake camera, on the real printer's ports
// (SDCP WebSocket on 3030, MJPEG camera on 3031), so the service or its
// container image can be pointed at them with PRINTER_IP. The fake printer
// simulates a running print (scripts/fake-print-simulation.ts): progress,
// layers, and time advance, and pause, resume, stop, and the light change its
// state as the printer would. It also keeps a job history (Cmd 320/321: the 26
// recorded jobs plus the simulated one) whose thumbnails are served over HTTP
// on a free port of the same host. Stop it with Ctrl-C.
//
// Environment:
//   FAKE_HOST     address to listen on (default 127.0.0.1; 0.0.0.0 to reach it
//                 from a container on a bridge network)
//   FAKE_PRINTER_IP the address the thumbnail URLs name, as the real printer
//                 names its own: set it to the service's PRINTER_IP when that
//                 is not FAKE_HOST (always with a wildcard FAKE_HOST), since
//                 the service fetches thumbnails from the PRINTER_IP host only
//                 (default FAKE_HOST, or 127.0.0.1 for 0.0.0.0 and ::)
//   FAKE_SPEED    simulated print seconds per real second (default 10)
//   FAKE_CAMERA   "down" starts with the camera answering 503
//   FAKE_REPLIES  per-command replies, e.g. "129=silent,131=2": "silent" sends
//                 no response (the command times out after 10 s), a number
//                 answers with that Ack (failed); the state then doesn't change
// Signals:
//   SIGUSR1       toggles the camera down (open streams end, new ones get 503) and back
//   SIGUSR2       toggles the printer offline (silent, connections dropped) and back
import { startFakePrint } from "./fake-print-simulation.ts";

const host = process.env.FAKE_HOST || "127.0.0.1";
const thumbnailHost = process.env.FAKE_PRINTER_IP || undefined;
const fake = await startFakePrint({ host, thumbnailHost, printerPort: 3030, cameraPort: 3031 });
console.info(`fake printer on ${host}:3030, fake camera on ${host}:3031`);
console.info("point the service at it with PRINTER_IP set to an address of this host");
if (thumbnailHost === undefined && (host === "0.0.0.0" || host === "::")) {
  console.warn("thumbnail URLs name 127.0.0.1: set FAKE_PRINTER_IP to the service's PRINTER_IP to have them fetched");
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void (async () => {
      await fake.stop();
      process.exit(0);
    })();
  });
}
