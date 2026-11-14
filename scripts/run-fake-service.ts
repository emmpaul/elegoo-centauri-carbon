// Runs the service against the fake printer and a fake camera, all on
// 127.0.0.1, for trying the API and the dashboard without the real printer.
// The fake printer simulates a running print (scripts/fake-print-simulation.ts):
// progress, layers, and time advance, and pause, resume, stop, and the light
// change its state as the printer would. Stop it with Ctrl-C.
//
// Environment:
//   LISTEN_PORT   API port (default 8080)
//   ACCESS_TOKEN  access token (default none)
//   FAKE_SPEED    simulated print seconds per real second (default 10)
//   FAKE_CAMERA   "down" starts with the camera answering 503
//   FAKE_REPLIES  per-command replies, e.g. "129=silent,131=2": "silent" sends
//                 no response (the command times out after 10 s), a number
//                 answers with that Ack (failed); the state then doesn't change
// Signals:
//   SIGUSR1       toggles the camera down (open streams end, new ones get 503) and back
//   SIGUSR2       toggles the printer offline (silent, connections dropped) and back
import { startService } from "../src/service.ts";
import { startFakePrint } from "./fake-print-simulation.ts";

const fake = await startFakePrint();
const service = await startService({
  printerUrl: fake.printer.url,
  cameraUrl: fake.camera.url,
  listen: { host: "127.0.0.1", port: Number(process.env.LISTEN_PORT || 8080) },
  token: process.env.ACCESS_TOKEN || null,
});

// Push the first status until the session has its socket open and takes it.
while (service.store.snapshot.connection !== "online") {
  fake.pushStatus();
  await new Promise((resolve) => setTimeout(resolve, 50));
}
console.info(`fake printer ${fake.printer.url}, fake camera ${fake.camera.url}`);
console.info(`API and dashboard on http://127.0.0.1:${service.address.port}/`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void (async () => {
      await service.close();
      await fake.stop();
      process.exit(0);
    })();
  });
}
