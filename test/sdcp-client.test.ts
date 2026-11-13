import { strict as assert } from "node:assert";
import { once } from "node:events";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  ALLOWED_COMMANDS,
  buildRequest,
  checkProtocolVersion,
  Cmd,
  CommandTimeoutError,
  type Logger,
  SdcpClient,
  sdcpUrl,
  UndocumentedCommandError,
} from "../src/sdcp-client.ts";
import { FakePrinter, FIXTURE_MAINBOARD_ID, loadFixture } from "./support/fake-printer.ts";

function recordingLogger(): Logger & { warnings: string[]; errors: string[] } {
  const warnings: string[] = [];
  const errors: string[] = [];
  return { warnings, errors, info: () => {}, warn: (m) => warnings.push(m), error: (m) => errors.push(m) };
}

function attributesWithVersion(version: string): unknown {
  const fixture = loadFixture("connect-loading.json");
  const frame = fixture.frames.find((f) => typeof f.payload === "object" && f.payload !== null && "Attributes" in f.payload);
  assert.ok(frame, "connect-loading.json has an attributes push");
  const message = structuredClone(frame.payload) as { Attributes: Record<string, unknown> };
  message.Attributes.ProtocolVersion = version;
  return message;
}

describe("buildRequest", () => {
  it("builds the envelope the web UI sends", () => {
    const sent = loadFixture("connect-loading.json").frames.find((f) => f.direction === "sent" && typeof f.payload === "object");
    const recorded = sent?.payload as { Data: { Cmd: number; RequestID: string; TimeStamp: number } };
    const built = buildRequest(recorded.Data.Cmd, {}, "", recorded.Data.RequestID, recorded.Data.TimeStamp);
    assert.deepEqual(built, recorded);
  });

  it("generates a 32-character hex RequestID by default", () => {
    assert.match(buildRequest(0).Data.RequestID, /^[0-9a-f]{32}$/);
  });
});

describe("sdcpUrl", () => {
  it("points at port 3030 /websocket", () => {
    assert.equal(sdcpUrl("192.0.2.10"), "ws://192.0.2.10:3030/websocket");
  });
});

describe("checkProtocolVersion", () => {
  it("accepts the documented version silently", () => {
    const logger = recordingLogger();
    assert.equal(checkProtocolVersion("V3.0.0", logger), true);
    assert.deepEqual(logger.warnings, []);
  });

  it("warns, naming an unknown version", () => {
    const logger = recordingLogger();
    assert.equal(checkProtocolVersion("V9.9.9", logger), false);
    assert.equal(logger.warnings.length, 1);
    assert.match(logger.warnings[0] ?? "", /V9\.9\.9/);
  });
});

describe("SdcpClient", () => {
  let printer: FakePrinter;
  let client: SdcpClient;
  let logger: ReturnType<typeof recordingLogger>;

  beforeEach(async () => {
    printer = await FakePrinter.start({ replies: { [Cmd.SEND_PRINTER_SUSPEND_PRINT]: 2, [Cmd.SEND_PRINTER_STOP_PRINT]: "silent" } });
    logger = recordingLogger();
    client = new SdcpClient({ url: printer.url, logger, responseTimeoutMs: 300 });
    await client.connect();
  });

  afterEach(async () => {
    client.close();
    await printer.close();
  });

  it("correlates responses by RequestID", async () => {
    const [status, attributes] = await Promise.all([client.send(Cmd.GET_PRINTER_STATUS), client.send(Cmd.GET_PRINTER_ATTR)]);
    assert.equal(status.Data.Cmd, Cmd.GET_PRINTER_STATUS);
    assert.equal(attributes.Data.Cmd, Cmd.GET_PRINTER_ATTR);
    assert.equal(status.Data.MainboardID, FIXTURE_MAINBOARD_ID);
    const sent = printer.received.map((f) => f.payload as { Data: { RequestID: string } });
    assert.equal(status.Data.RequestID, sent[0]?.Data.RequestID);
    assert.equal(attributes.Data.RequestID, sent[1]?.Data.RequestID);
  });

  it("returns a failure Ack as the response", async () => {
    const response = await client.send(Cmd.SEND_PRINTER_SUSPEND_PRINT);
    assert.equal(response.Data.Data.Ack, 2);
  });

  it("rejects with a timeout when no response arrives", async () => {
    await assert.rejects(client.send(Cmd.SEND_PRINTER_STOP_PRINT), CommandTimeoutError);
  });

  for (const cmd of [999, 128, 259, 64]) {
    it(`refuses command ${cmd}, logs an error, and sends nothing`, async () => {
      assert.equal(ALLOWED_COMMANDS.has(cmd), false);
      await assert.rejects(client.send(cmd), UndocumentedCommandError);
      await client.send(Cmd.GET_PRINTER_STATUS); // a later frame proves the refused one never went out
      assert.deepEqual(printer.receivedCommands, [Cmd.GET_PRINTER_STATUS]);
      assert.equal(logger.errors.length, 1);
      assert.match(logger.errors[0] ?? "", new RegExp(`\\b${cmd}\\b`));
    });
  }

  it("emits status pushes from a fixture", async () => {
    const statuses = once(client, "status");
    printer.replay(loadFixture("connect-printing.json"), (f) => String((f.payload as { Topic?: string }).Topic).startsWith("sdcp/status/"));
    const [message] = await statuses;
    assert.ok("CurrentStatus" in message.Status);
  });

  it("logs a warning for an unknown protocol version and stays connected", async () => {
    const attributes = once(client, "attributes");
    printer.push(attributesWithVersion("V9.9.9"));
    await attributes;
    assert.equal(logger.warnings.length, 1);
    assert.match(logger.warnings[0] ?? "", /V9\.9\.9/);
    assert.equal(client.isOpen, true);
    const response = await client.send(Cmd.GET_PRINTER_STATUS);
    assert.equal(response.Data.Data.Ack, 0);
  });

  it("does not warn for the documented protocol version", async () => {
    const attributes = once(client, "attributes");
    printer.push(attributesWithVersion("V3.0.0"));
    await attributes;
    assert.deepEqual(logger.warnings, []);
  });
});
