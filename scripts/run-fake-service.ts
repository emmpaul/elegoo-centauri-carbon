// Runs the service against the fake printer and a fake camera, all on
// 127.0.0.1, for trying the API and the dashboard without the real printer.
// The fake printer simulates a running print: progress, layers, and time
// advance, and pause, resume, stop, and the light change its state as the
// printer would. Stop it with Ctrl-C.
//
// Environment:
//   LISTEN_PORT   API port (default 8080)
//   ACCESS_TOKEN  access token (default none)
//   FAKE_SPEED    simulated print seconds per real second (default 10)
// Signals:
//   SIGUSR2       toggles the printer offline (silent, connections dropped) and back
import { startService } from "../src/service.ts";
import { FakeMjpegSource } from "../test/support/fake-mjpeg.ts";
import { FakePrinter, loadFixture, type ReceivedFrame } from "../test/support/fake-printer.ts";

interface PrintInfo {
  Status: number;
  CurrentLayer: number;
  TotalLayer: number;
  CurrentTicks: number;
  TotalTicks: number;
  Filename: string;
  TaskId: string;
  Progress: number;
  [key: string]: unknown;
}

interface FakeStatus {
  Status: {
    CurrentStatus: number[];
    TempOfNozzle: number;
    TempOfHotbed: number;
    TempOfBox: number;
    LightStatus: { SecondLight: number; RgbLight: number[] };
    PrintInfo: PrintInfo;
    [key: string]: unknown;
  };
  TimeStamp: number;
  [key: string]: unknown;
}

function fixturePayload(fixture: string, seq: number): unknown {
  const payload = loadFixture(fixture).frames.find((f) => f.seq === seq)?.payload;
  if (payload === undefined) throw new Error(`${fixture}#${seq} is missing`);
  return payload;
}

const state = structuredClone(fixturePayload("control-pause-resume-light.json", 11)) as FakeStatus; // printing, light on
const attributes = fixturePayload("connect-loading.json", 17);
const speed = Number(process.env.FAKE_SPEED || 10);

const printer = await FakePrinter.start();
const camera = await FakeMjpegSource.start({ frameIntervalMs: 200 });
const service = await startService({
  printerUrl: printer.url,
  cameraUrl: camera.url,
  listen: { host: "127.0.0.1", port: Number(process.env.LISTEN_PORT || 8080) },
  token: process.env.ACCESS_TOKEN || null,
});

function pushStatus(): void {
  state.TimeStamp = Math.floor(Date.now() / 1000);
  printer.push(state);
}

function setPrintStatus(code: number, machine = 1): void {
  state.Status.PrintInfo.Status = code;
  state.Status.CurrentStatus = [machine];
  pushStatus();
}

/** Acts on a request as the printer would: answers status and attributes, and applies control commands. */
function onRequest(frame: ReceivedFrame): void {
  const data = (frame.payload as { Data?: { Cmd?: unknown; Data?: Record<string, unknown> } }).Data;
  if (typeof data?.Cmd !== "number") return;
  switch (data.Cmd) {
    case 0: // status request: the printer pushes a status message
      setTimeout(pushStatus, 20);
      break;
    case 1: // attributes request: the printer pushes an attributes message
      setTimeout(() => printer.push(attributes), 20);
      break;
    case 129: // pause: pausing, then paused
      setPrintStatus(5);
      setTimeout(() => setPrintStatus(6), 1500);
      break;
    case 131: // resume: restoring, then printing
      setPrintStatus(12);
      setTimeout(() => setPrintStatus(13), 1500);
      break;
    case 130: // stop: stopping, then stopped
      setPrintStatus(1, 0);
      setTimeout(() => setPrintStatus(8, 0), 1500);
      break;
    case 403: {
      const light = data.Data?.LightStatus as { SecondLight?: number } | undefined;
      if (typeof light?.SecondLight === "number") state.Status.LightStatus.SecondLight = light.SecondLight;
      pushStatus();
      break;
    }
  }
}

/** Advances the running print once per second; at the end it completes, as the printer reports it. */
function tick(): void {
  const s = state.Status;
  const info = s.PrintInfo;
  s.TempOfNozzle = 210 + (Math.random() - 0.5) * 0.6;
  s.TempOfHotbed = 60 + (Math.random() - 0.5) * 0.4;
  s.TempOfBox = 30.5 + (Math.random() - 0.5) * 0.2;
  if (info.Status === 13) {
    info.CurrentTicks = Math.min(info.TotalTicks, info.CurrentTicks + speed);
    const fraction = info.CurrentTicks / info.TotalTicks;
    info.Progress = Math.floor(fraction * 100);
    info.CurrentLayer = Math.max(1, Math.round(fraction * info.TotalLayer));
    if (info.CurrentTicks >= info.TotalTicks) {
      // The printer clears the file name and progress once the job completes.
      Object.assign(info, { Status: 9, Progress: 0, Filename: "", TaskId: "" });
      s.CurrentStatus = [0];
    }
  }
  pushStatus();
}

printer.onFrame(onRequest);
const ticker = setInterval(tick, 1000);

// Push the first status until the session has its socket open and takes it.
while (service.store.snapshot.connection !== "online") {
  pushStatus();
  await new Promise((resolve) => setTimeout(resolve, 50));
}
console.info(`fake printer ${printer.url}, fake camera ${camera.url}`);
console.info(`API and dashboard on http://127.0.0.1:${service.address.port}/`);

let offline = false;
process.on("SIGUSR2", () => {
  offline = !offline;
  printer.goSilent(offline);
  if (offline) printer.dropClients();
  console.info(`fake printer ${offline ? "offline" : "back online"}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void (async () => {
      clearInterval(ticker);
      await service.close();
      await printer.close();
      await camera.close();
      process.exit(0);
    })();
  });
}
