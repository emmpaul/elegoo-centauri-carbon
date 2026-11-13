import { strict as assert } from "node:assert";
import { createSocket } from "node:dgram";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { DISCOVERY_PROBE, discover, parseDiscoveryReply, resolvePrinterAddress } from "../src/discovery.ts";

const discoveryFixture = JSON.parse(
  readFileSync(new URL("./fixtures/discovery-reply.json", import.meta.url), "utf8"),
) as { frames: { seq: number; direction: "sent" | "received"; payload: unknown }[] };
const recordedReply = JSON.stringify(discoveryFixture.frames.find((f) => f.direction === "received")?.payload);

describe("parseDiscoveryReply", () => {
  it("parses the recorded reply of the printer", () => {
    assert.deepEqual(parseDiscoveryReply(recordedReply, "192.0.2.99"), {
      id: "979d4C788A4a78bC777A870F1A02867A",
      name: "Centauri Carbon",
      ip: "192.0.2.10",
      mainboardId: "40551f980103d46c00004c0000000000",
      protocolVersion: "V3.0.0",
      firmwareVersion: "V1.4.49",
    });
  });

  it("matches the probe recorded in the fixture", () => {
    assert.equal(discoveryFixture.frames.find((f) => f.direction === "sent")?.payload, DISCOVERY_PROBE);
  });

  it("falls back to the sender address when MainboardIP is missing", () => {
    const reply = JSON.parse(recordedReply) as { Data: Record<string, unknown> };
    delete reply.Data.MainboardIP;
    assert.equal(parseDiscoveryReply(JSON.stringify(reply), "192.0.2.99")?.ip, "192.0.2.99");
  });

  it("returns null for text that is not JSON", () => {
    assert.equal(parseDiscoveryReply("M99999", "192.0.2.10"), null);
  });

  it("returns null when the reply has no mainboard id", () => {
    assert.equal(parseDiscoveryReply(JSON.stringify({ Id: "x", Data: { Name: "n" } }), "192.0.2.10"), null);
  });
});

describe("resolvePrinterAddress", () => {
  it("uses the configured address and never calls discovery", async () => {
    let calls = 0;
    const ip = await resolvePrinterAddress({
      printerIp: "192.168.0.96",
      discover: async () => {
        calls++;
        return [];
      },
    });
    assert.equal(ip, "192.168.0.96");
    assert.equal(calls, 0);
  });

  it("falls back to the first discovered printer", async () => {
    const ip = await resolvePrinterAddress({
      printerIp: null,
      discover: async () => [
        { id: "", name: "Centauri Carbon", ip: "192.0.2.10", mainboardId: "m", protocolVersion: "V3.0.0", firmwareVersion: "V1.4.49" },
      ],
    });
    assert.equal(ip, "192.0.2.10");
  });

  it("fails with a hint when nothing answers", async () => {
    await assert.rejects(resolvePrinterAddress({ printerIp: null, discover: async () => [] }), /printerIp/);
  });
});

describe("discover", () => {
  it("collects the printer from a recorded reply", async () => {
    const server = createSocket("udp4");
    server.on("message", (_msg, rinfo) => server.send(recordedReply, rinfo.port, rinfo.address));
    await new Promise<void>((resolve) => server.bind(0, "127.0.0.1", resolve));
    try {
      const printers = await discover({ address: "127.0.0.1", port: server.address().port, timeoutMs: 200 });
      assert.equal(printers.length, 1);
      assert.equal(printers[0]?.mainboardId, "40551f980103d46c00004c0000000000");
      assert.equal(printers[0]?.ip, "192.0.2.10");
    } finally {
      server.close();
    }
  });

  it("sends the probe and ignores replies that are not printers", async () => {
    const server = createSocket("udp4");
    const probes: string[] = [];
    server.on("message", (msg, rinfo) => {
      probes.push(msg.toString());
      server.send("not json", rinfo.port, rinfo.address);
    });
    await new Promise<void>((resolve) => server.bind(0, "127.0.0.1", resolve));
    try {
      const printers = await discover({ address: "127.0.0.1", port: server.address().port, timeoutMs: 200 });
      assert.deepEqual(probes, [DISCOVERY_PROBE]);
      assert.deepEqual(printers, []);
    } finally {
      server.close();
    }
  });
});
