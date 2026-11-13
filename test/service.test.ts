import { strict as assert } from "node:assert";
import { connect, createServer } from "node:net";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Logger } from "../src/sdcp-client.ts";
import { type Service, startService } from "../src/service.ts";
import { FakePrinter } from "./support/fake-printer.ts";

function silentLogger(): Logger {
  return { info() {}, warn() {}, error() {} };
}

/** A port that was free a moment ago. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** Whether anything accepts connections on the port. */
async function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

describe("startService listen rule", () => {
  let printer: FakePrinter;
  let service: Service | undefined;

  beforeEach(async () => {
    printer = await FakePrinter.start();
  });

  afterEach(async () => {
    await service?.close();
    service = undefined;
    await printer.close();
  });

  it("rejects 0.0.0.0 without a token and opens no port", async () => {
    const port = await freePort();
    await assert.rejects(
      startService({
        printerUrl: printer.url,
        cameraUrl: "http://127.0.0.1:9/video",
        listen: { host: "0.0.0.0", port },
        token: null,
        logger: silentLogger(),
      }),
      /0\.0\.0\.0.*ACCESS_TOKEN.*LISTEN_HOST/,
    );
    assert.equal(await listening(port), false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(printer.clientCount, 0);
  });

  it("starts on 127.0.0.1 without a token", async () => {
    service = await startService({
      printerUrl: printer.url,
      cameraUrl: "http://127.0.0.1:9/video",
      listen: { host: "127.0.0.1", port: 0 },
      token: null,
      logger: silentLogger(),
    });
    assert.ok(service.address.port > 0);
    assert.equal(await listening(service.address.port), true);
    await printer.waitForClient();
  });
});
