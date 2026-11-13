import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { EVENT_TYPES, defaultConfig, listenAuthError, loadConfig } from "../src/config.ts";

const dir = mkdtempSync(join(tmpdir(), "ecc-config-"));
after(() => rmSync(dir, { recursive: true, force: true }));

function writeConfig(name: string, contents: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, typeof contents === "string" ? contents : JSON.stringify(contents));
  return path;
}

describe("loadConfig", () => {
  it("uses defaults when the file is missing and no env is set", () => {
    const config = loadConfig({ path: join(dir, "missing.json"), env: {} });
    assert.deepEqual(config, defaultConfig());
    assert.equal(config.printerIp, null);
    assert.deepEqual(config.listen, { host: "0.0.0.0", port: 8080 });
    assert.equal(config.token, null);
    assert.deepEqual(config.ntfy, { url: "https://ntfy.sh", topic: null });
    for (const event of EVENT_TYPES) assert.equal(config.events[event], true);
  });

  it("reads values from the file and keeps defaults for missing keys", () => {
    const path = writeConfig("partial.json", {
      printerIp: "192.168.0.96",
      listen: { port: 9000 },
      token: "secret",
      ntfy: { topic: "my-printer" },
      events: { started: false },
    });
    const config = loadConfig({ path, env: {} });
    assert.equal(config.printerIp, "192.168.0.96");
    assert.deepEqual(config.listen, { host: "0.0.0.0", port: 9000 });
    assert.equal(config.token, "secret");
    assert.deepEqual(config.ntfy, { url: "https://ntfy.sh", topic: "my-printer" });
    assert.equal(config.events.started, false);
    assert.equal(config.events.finished, true);
  });

  it("loads config.example.json", () => {
    const config = loadConfig({ path: "config.example.json", env: {} });
    assert.equal(config.printerIp, "192.168.0.96");
    assert.deepEqual(config.listen, { host: "127.0.0.1", port: 8080 });
    assert.equal(config.token, null);
    assert.equal(listenAuthError(config.listen, config.token), null);
  });

  it("lets env variables override file values", () => {
    const path = writeConfig("full.json", {
      printerIp: "192.168.0.96",
      listen: { host: "127.0.0.1", port: 9000 },
      token: "file-token",
      ntfy: { url: "https://ntfy.example", topic: "file-topic" },
    });
    const config = loadConfig({
      path,
      env: {
        PRINTER_IP: "10.0.0.5",
        LISTEN_HOST: "192.168.0.10",
        LISTEN_PORT: "8181",
        ACCESS_TOKEN: "env-token",
        NTFY_URL: "https://ntfy.local",
        NTFY_TOPIC: "env-topic",
        NOTIFY_EVENTS: "finished, failed",
      },
    });
    assert.equal(config.printerIp, "10.0.0.5");
    assert.deepEqual(config.listen, { host: "192.168.0.10", port: 8181 });
    assert.equal(config.token, "env-token");
    assert.deepEqual(config.ntfy, { url: "https://ntfy.local", topic: "env-topic" });
    assert.deepEqual(
      EVENT_TYPES.filter((e) => config.events[e]),
      ["finished", "failed"],
    );
  });

  it("treats empty env variables as unset", () => {
    const path = writeConfig("token.json", { token: "file-token" });
    const config = loadConfig({ path, env: { ACCESS_TOKEN: "", PRINTER_IP: "" } });
    assert.equal(config.token, "file-token");
    assert.equal(config.printerIp, null);
  });

  it("turns every event off with NOTIFY_EVENTS=none", () => {
    const config = loadConfig({ path: join(dir, "missing.json"), env: { NOTIFY_EVENTS: "none" } });
    for (const event of EVENT_TYPES) assert.equal(config.events[event], false);
  });

  it("finds the file through CONFIG_PATH", () => {
    const path = writeConfig("via-env.json", { printerIp: "192.168.0.50" });
    assert.equal(loadConfig({ env: { CONFIG_PATH: path } }).printerIp, "192.168.0.50");
  });

  it("rejects invalid values", () => {
    assert.throws(() => loadConfig({ path: writeConfig("bad.json", "{not json"), env: {} }), /invalid JSON/);
    assert.throws(() => loadConfig({ path: writeConfig("port.json", { listen: { port: 70000 } }), env: {} }), /port/);
    assert.throws(() => loadConfig({ path: writeConfig("event.json", { events: { exploded: true } }), env: {} }), /unknown event/);
    assert.throws(() => loadConfig({ path: join(dir, "missing.json"), env: { LISTEN_PORT: "abc" } }), /LISTEN_PORT/);
    assert.throws(() => loadConfig({ path: join(dir, "missing.json"), env: { NOTIFY_EVENTS: "finished,bogus" } }), /unknown event/);
  });
});

describe("listenAuthError", () => {
  const exposed = ["0.0.0.0", "::", "192.0.2.10", "printer.example"];
  const loopback = ["127.0.0.1", "127.1.2.3", "localhost", "::1"];

  for (const host of exposed) {
    it(`refuses ${host} without a token`, () => {
      const message = listenAuthError({ host }, null);
      assert.ok(message !== null);
      assert.ok(message.includes(host));
      for (const name of ["token", "ACCESS_TOKEN", "listen.host", "LISTEN_HOST"]) assert.ok(message.includes(name), name);
    });

    it(`allows ${host} with a token`, () => {
      assert.equal(listenAuthError({ host }, "secret"), null);
    });
  }

  for (const host of loopback) {
    it(`allows ${host} without a token`, () => {
      assert.equal(listenAuthError({ host }, null), null);
    });

    it(`allows ${host} with a token`, () => {
      assert.equal(listenAuthError({ host }, "secret"), null);
    });
  }
});
