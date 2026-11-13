// Runs the service against the fake printer and a fake camera, all on
// 127.0.0.1, for trying the API and the dashboard without the real printer.
// The fake printer reports a running print. LISTEN_PORT (default 8080) and
// ACCESS_TOKEN set the API port and token. Stop it with Ctrl-C.
import { startService } from "../src/service.ts";
import { FakeMjpegSource } from "../test/support/fake-mjpeg.ts";
import { FakePrinter, loadFixture } from "../test/support/fake-printer.ts";

const printing = loadFixture("control-pause-resume-light.json").frames.find((f) => f.seq === 11)?.payload;
if (printing === undefined) throw new Error("control-pause-resume-light.json#11 is missing");

const printer = await FakePrinter.start();
const camera = await FakeMjpegSource.start({ frameIntervalMs: 200 });
const service = await startService({
  printerUrl: printer.url,
  cameraUrl: camera.url,
  listen: { host: "127.0.0.1", port: Number(process.env.LISTEN_PORT || 8080) },
  token: process.env.ACCESS_TOKEN || null,
});
// Push the first status until the session has its socket open and takes it.
while (service.store.snapshot.connection !== "online") {
  printer.push(printing);
  await new Promise((resolve) => setTimeout(resolve, 50));
}
console.info(`fake printer ${printer.url}, fake camera ${camera.url}`);
console.info(`API on http://127.0.0.1:${service.address.port}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void (async () => {
      await service.close();
      await printer.close();
      await camera.close();
      process.exit(0);
    })();
  });
}
