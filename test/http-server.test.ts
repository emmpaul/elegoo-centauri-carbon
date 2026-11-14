import { strict as assert } from "node:assert";
import { EventEmitter, once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";
import { dashboardFiles } from "../src/dashboard-files.ts";
import { createApiServer } from "../src/http-server.ts";
import { type CommandSender, PrintControl } from "../src/print-control.ts";
import { PrinterSession } from "../src/printer-session.ts";
import { Cmd, CommandTimeoutError, type Logger, NotConnectedError, type StatusMessage } from "../src/sdcp-client.ts";
import { type StatusSnapshot, StatusStore } from "../src/status-store.ts";
import { FakePrinter, loadFixture } from "./support/fake-printer.ts";

const quiet: Logger = { info: () => {}, warn: () => {}, error: () => {} };
const CONNECT_COMMANDS = [Cmd.GET_PRINTER_STATUS, Cmd.GET_PRINTER_ATTR];

function statusPush(fixture: string, seq: number): StatusMessage {
  const frame = loadFixture(fixture).frames.find((f) => f.seq === seq);
  assert.ok(frame && typeof frame.payload === "object" && frame.payload !== null && "Status" in frame.payload);
  return frame.payload as StatusMessage;
}

const PRINTING = statusPush("control-pause-resume-light.json", 11); // 1/13, light on
const PAUSING = statusPush("control-pause-resume-light.json", 12); // 1/5

function isCmd(cmd: number) {
  return (frame: { payload: unknown }) => (frame.payload as { Data?: { Cmd?: number } }).Data?.Cmd === cmd;
}

async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** Reads `event: status` messages from an SSE response body. */
class SseReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private buffer = "";

  constructor(response: Response) {
    assert.ok(response.body);
    this.reader = response.body.getReader();
  }

  async next(): Promise<StatusSnapshot> {
    for (;;) {
      const end = this.buffer.indexOf("\n\n");
      if (end !== -1) {
        const block = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 2);
        if (block.startsWith(":")) continue;
        const lines = block.split("\n");
        assert.ok(lines.includes("event: status"), `unexpected event block: ${block}`);
        const data = lines.find((line) => line.startsWith("data: "));
        assert.ok(data);
        return JSON.parse(data.slice("data: ".length)) as StatusSnapshot;
      }
      const { value, done } = await this.reader.read();
      assert.ok(!done, "stream ended");
      this.buffer += this.decoder.decode(value, { stream: true });
    }
  }

  async cancel(): Promise<void> {
    await this.reader.cancel();
  }
}

function postCommand(base: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}/api/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("HTTP API against the fake printer", () => {
  let printer: FakePrinter;
  let session: PrinterSession;
  let store: StatusStore;
  let server: Server;
  let base: string;

  async function start(token: string | null): Promise<void> {
    printer = await FakePrinter.start();
    session = new PrinterSession({ url: printer.url, logger: quiet });
    store = new StatusStore();
    store.attach(session);
    server = createApiServer({ store, control: new PrintControl(session, store), token, logger: quiet });
    base = await listen(server);
    const attributesRequest = printer.nextFrame(isCmd(Cmd.GET_PRINTER_ATTR));
    session.start();
    await attributesRequest;
    const change = once(store, "change");
    printer.push(PRINTING);
    await change;
    assert.equal(store.snapshot.connection, "online");
  }

  /** Command ids the fake received after the connect requests, after a Cmd 0 round-trip. */
  async function commandsSent(): Promise<number[]> {
    await session.send(Cmd.GET_PRINTER_STATUS);
    const received = printer.receivedCommands;
    assert.deepEqual(received.slice(0, 2), CONNECT_COMMANDS);
    return received.slice(2, -1);
  }

  afterEach(async () => {
    await closeServer(server);
    session.stop();
    await printer.close();
  });

  describe("without a token", () => {
    beforeEach(() => start(null));

    it("GET /api/status returns the snapshot", async () => {
      const response = await fetch(`${base}/api/status`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /^application\/json/);
      const snapshot = (await response.json()) as StatusSnapshot;
      assert.equal(snapshot.connection, "online");
      assert.equal(snapshot.printState.name, "printing");
      assert.deepEqual(snapshot, store.snapshot);
    });

    it("GET /api/events sends the snapshot, then each update within 1 s", async () => {
      const response = await fetch(`${base}/api/events`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/);
      const events = new SseReader(response);
      assert.equal((await events.next()).printState.name, "printing");

      const started = performance.now();
      printer.push(PAUSING);
      const update = await events.next();
      assert.ok(performance.now() - started < 1000, "update arrived within 1 s");
      assert.equal(update.printState.name, "pausing");

      const offline = events.next();
      printer.dropClients();
      assert.equal((await offline).connection, "offline");
      await events.cancel();
    });

    it("stops listening to the store when an SSE client leaves", async () => {
      const before = store.listenerCount("change");
      const response = await fetch(`${base}/api/events`);
      const events = new SseReader(response);
      await events.next();
      assert.equal(store.listenerCount("change"), before + 1);
      await events.cancel();
      for (let i = 0; i < 50 && store.listenerCount("change") > before; i++) await new Promise((r) => setTimeout(r, 10));
      assert.equal(store.listenerCount("change"), before);
    });

    it("POST /api/command round-trips pause to the printer and reports acknowledged", async () => {
      const response = await postCommand(base, { action: "pause" });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { action: "pause", outcome: "acknowledged" });
      assert.deepEqual(await commandsSent(), [Cmd.SEND_PRINTER_SUSPEND_PRINT]);
    });

    it("POST /api/command round-trips stop with confirm and light with on", async () => {
      assert.deepEqual(await (await postCommand(base, { action: "light", on: false })).json(), {
        action: "light",
        outcome: "acknowledged",
      });
      assert.deepEqual(await (await postCommand(base, { action: "stop", confirm: true })).json(), {
        action: "stop",
        outcome: "acknowledged",
      });
      assert.deepEqual(await commandsSent(), [Cmd.EDIT_PRINTER_STATUS_DATA, Cmd.SEND_PRINTER_STOP_PRINT]);
    });

    it("reports a failed command with the printer's code", async () => {
      printer.replies.set(Cmd.SEND_PRINTER_SUSPEND_PRINT, 1);
      const response = await postCommand(base, { action: "pause" });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { action: "pause", outcome: "failed", code: 1 });
    });

    it("answers 409 for a command the state does not allow, sending nothing", async () => {
      const response = await postCommand(base, { action: "resume" });
      assert.equal(response.status, 409);
      assert.equal(((await response.json()) as { error: { code: string } }).error.code, "not-allowed");
      assert.deepEqual(await commandsSent(), []);
    });

    it("answers 400 for stop without confirmation, sending nothing", async () => {
      for (const body of [{ action: "stop" }, { action: "stop", confirm: "yes" }]) {
        const response = await postCommand(base, body);
        assert.equal(response.status, 400);
        assert.equal(((await response.json()) as { error: { code: string } }).error.code, "confirmation-required");
      }
      assert.deepEqual(await commandsSent(), []);
      assert.equal(store.snapshot.printState.name, "printing");
    });

    it("answers 400 for bad bodies, sending nothing", async () => {
      const bad: [string, string][] = [
        ["application/json", "{not json"],
        ["application/json", "[]"],
        ["application/json", '{"action":"jog"}'],
        ["application/json", '{"action":"light"}'],
        ["text/plain", '{"action":"pause"}'],
        ["application/json", JSON.stringify({ action: "pause", pad: "x".repeat(5000) })],
      ];
      for (const [type, body] of bad) {
        const response = await fetch(`${base}/api/command`, { method: "POST", headers: { "Content-Type": type }, body });
        assert.equal(response.status, 400, body.slice(0, 40));
        assert.equal(((await response.json()) as { error: { code: string } }).error.code, "bad-request");
      }
      assert.deepEqual(await commandsSent(), []);
    });

    it("answers 404 for unknown paths and 405 for wrong methods", async () => {
      assert.equal((await fetch(`${base}/api/nope`)).status, 404);
      const wrong = await fetch(`${base}/api/command`);
      assert.equal(wrong.status, 405);
      assert.equal(wrong.headers.get("allow"), "POST");
      assert.equal((await fetch(`${base}/api/status`, { method: "POST" })).status, 405);
    });
  });

  describe("with a token", () => {
    const TOKEN = "s3cret-token";
    beforeEach(() => start(TOKEN));

    it("answers 401 on every route without the token, and sends nothing", async () => {
      for (const [path, init] of [
        ["/api/status", {}],
        ["/api/events", {}],
        ["/api/command", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"action":"pause"}' }],
        ["/api/nope", {}],
      ] as const) {
        const response = await fetch(`${base}${path}`, init);
        assert.equal(response.status, 401, path);
        assert.match(response.headers.get("www-authenticate") ?? "", /^Bearer/);
        assert.equal(((await response.json()) as { error: { code: string } }).error.code, "unauthorized");
      }
      assert.deepEqual(await commandsSent(), []);
    });

    it("answers 401 for a wrong token", async () => {
      assert.equal((await fetch(`${base}/api/status`, { headers: { Authorization: "Bearer wrong" } })).status, 401);
      assert.equal((await fetch(`${base}/api/status?token=wrong`)).status, 401);
      assert.equal((await postCommand(base, { action: "pause" }, { Authorization: `Basic ${TOKEN}` })).status, 401);
      assert.deepEqual(await commandsSent(), []);
    });

    it("accepts the token as a bearer header or a query parameter", async () => {
      assert.equal((await fetch(`${base}/api/status`, { headers: { Authorization: `Bearer ${TOKEN}` } })).status, 200);
      assert.equal((await fetch(`${base}/api/status?token=${TOKEN}`)).status, 200);
      const events = await fetch(`${base}/api/events?token=${TOKEN}`);
      assert.equal(events.status, 200);
      await new SseReader(events).cancel();
      const response = await postCommand(base, { action: "pause" }, { Authorization: `Bearer ${TOKEN}` });
      assert.deepEqual(await response.json(), { action: "pause", outcome: "acknowledged" });
      assert.deepEqual(await commandsSent(), [Cmd.SEND_PRINTER_SUSPEND_PRINT]);
    });
  });
});

describe("HTTP API command errors from the session", () => {
  let server: Server;
  let base: string;
  let sender: CommandSender;

  beforeEach(async () => {
    const store = new StatusStore();
    store.applyStatus(PRINTING);
    store.setConnection("online");
    sender = { send: () => Promise.reject(new Error("not set")) };
    const control = new PrintControl({ send: (cmd, data) => sender.send(cmd, data) }, store);
    server = createApiServer({ store, control, token: null, logger: quiet });
    base = await listen(server);
  });

  afterEach(() => closeServer(server));

  it("answers 503 when the session drops before the command is answered", async () => {
    sender = { send: () => Promise.reject(new NotConnectedError("SDCP session closed before the response arrived")) };
    const response = await postCommand(base, { action: "pause" });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: { code: "not-connected", message: "SDCP session closed before the response arrived" },
    });
    // The server keeps serving afterwards.
    assert.equal((await fetch(`${base}/api/status`)).status, 200);
  });

  it("reports timeout with 200 when the printer does not answer", async () => {
    sender = { send: (cmd) => Promise.reject(new CommandTimeoutError(cmd, 10_000)) };
    const response = await postCommand(base, { action: "pause" });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { action: "pause", outcome: "timeout" });
  });

  it("answers 500 without details for an unexpected error", async () => {
    sender = { send: () => Promise.reject(new Error("boom")) };
    const response = await postCommand(base, { action: "pause" });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: { code: "internal", message: "internal error" } });
  });
});

/** Sends `head` as raw bytes and returns the whole response text. */
async function rawRequest(base: string, head: string): Promise<string> {
  const { hostname, port } = new URL(base);
  const socket = connect(Number(port), hostname);
  await once(socket, "connect");
  socket.end(head);
  let text = "";
  socket.setEncoding("latin1");
  for await (const chunk of socket) text += chunk;
  return text;
}

describe("HTTP API on malformed requests", () => {
  let server: Server;
  let base: string;

  async function start(token: string | null): Promise<void> {
    const store = new StatusStore();
    store.applyStatus(PRINTING);
    const control = new PrintControl({ send: () => Promise.reject(new Error("no printer")) }, store);
    server = createApiServer({ store, control, token, logger: quiet });
    base = await listen(server);
  }

  afterEach(() => closeServer(server));

  for (const token of [null, "s3cret-token"]) {
    it(`answers 400 for a request-target that is not a URL and keeps serving (token ${token ? "set" : "unset"})`, async () => {
      await start(token);
      for (const target of ["http://[", "http://[::1/x", "//[/api/status"]) {
        const response = await rawRequest(base, `GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
        assert.match(response, /^HTTP\/1\.1 400 /, target);
        assert.match(response, /"code":"bad-request"/, target);
      }
      const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
      assert.equal((await fetch(`${base}/api/status`, { headers })).status, 200);
    });
  }
});

/** A store whose snapshot the test sets and announces. */
class FakeStore extends EventEmitter {
  snapshot = { connection: "online", pad: "" } as unknown as StatusSnapshot;

  publish(snapshot: StatusSnapshot): void {
    this.snapshot = snapshot;
    this.emit("change", snapshot);
  }
}

describe("HTTP API event stream limits", () => {
  let server: Server;
  let base: string;
  let store: FakeStore;
  let warnings: string[];

  async function start(limits: { maxEventBacklogBytes?: number; maxEventClients?: number }): Promise<void> {
    store = new FakeStore();
    warnings = [];
    const logger: Logger = { ...quiet, warn: (message: string) => warnings.push(message) };
    server = createApiServer({ store, control: {} as never, token: null, logger, ...limits });
    base = await listen(server);
  }

  afterEach(() => closeServer(server));

  async function until(condition: () => boolean, what: string): Promise<void> {
    for (let i = 0; i < 400; i++) {
      if (condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail(`timed out waiting for ${what}`);
  }

  it("drops a client that stops reading once its backlog passes the cap, and keeps serving", async () => {
    await start({ maxEventBacklogBytes: 256 * 1024 });
    const { port } = new URL(base);
    const slow = connect(Number(port), "127.0.0.1");
    await once(slow, "connect");
    slow.write("GET /api/events HTTP/1.1\r\nHost: x\r\n\r\n");
    await until(() => store.listenerCount("change") === 1, "the slow client to subscribe");
    slow.pause(); // never reads again, so the kernel buffers fill and the server backlog grows
    const closed = once(slow, "close");

    const pad = "x".repeat(64 * 1024);
    let published = 0;
    while (store.listenerCount("change") > 0) {
      assert.ok(published < 2000, "the slow client was never dropped");
      store.publish({ connection: "online", pad: `${published++}${pad}` } as unknown as StatusSnapshot);
      await new Promise((resolve) => setImmediate(resolve));
    }
    slow.resume();
    await closed;
    assert.ok(warnings.some((w) => /cannot keep up/.test(w)), "the drop is logged");

    const response = await fetch(`${base}/api/events`);
    assert.equal(response.status, 200);
    const events = new SseReader(response);
    store.publish({ connection: "offline" } as unknown as StatusSnapshot);
    await events.next();
    await events.cancel();
  });

  it("answers 503 past the client cap and admits a client again when one leaves", async () => {
    await start({ maxEventClients: 2 });
    const first = new SseReader(await fetch(`${base}/api/events`));
    const second = new SseReader(await fetch(`${base}/api/events`));
    await first.next();
    await second.next();

    const refused = await fetch(`${base}/api/events`);
    assert.equal(refused.status, 503);
    assert.equal(((await refused.json()) as { error: { code: string } }).error.code, "too-many-clients");
    assert.equal(store.listenerCount("change"), 2);

    await first.cancel();
    await until(() => store.listenerCount("change") === 1, "the first client to leave");
    const third = await fetch(`${base}/api/events`);
    assert.equal(third.status, 200);
    const thirdEvents = new SseReader(third);
    await thirdEvents.next();
    await second.cancel();
    await thirdEvents.cancel();
  });
});

describe("HTTP API dashboard files", () => {
  let server: Server;
  let base: string;

  beforeEach(async () => {
    const store = new StatusStore();
    const control = new PrintControl({ send: () => Promise.reject(new NotConnectedError()) }, store);
    server = createApiServer({ store, control, token: "secret", dashboard: dashboardFiles(), logger: quiet });
    base = await listen(server);
  });

  afterEach(() => closeServer(server));

  it("serves the page, its script with types stripped, and its styles without the token", async () => {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /^text\/html/);
    const html = await page.text();
    assert.match(html, /<script type="module" src="app\.js"><\/script>/);
    const themeAt = html.indexOf('<script src="theme.js"></script>');
    assert.ok(themeAt >= 0 && themeAt < html.indexOf('<link rel="stylesheet"'), "the theme applies before the stylesheet");

    const script = await fetch(`${base}/app.js`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get("content-type") ?? "", /^text\/javascript/);
    const source = await script.text();
    assert.doesNotMatch(source, /import type|: StatusSnapshot\b/, "types are stripped");
    assert.doesNotThrow(() => new Function(source.replace(/^import .*$/gm, "")), "the stripped script parses");

    for (const path of ["/mjpeg.js", "/view.js", "/src/control-rules.ts"]) {
      const module = await fetch(`${base}${path}`);
      assert.equal(module.status, 200, path);
      assert.match(module.headers.get("content-type") ?? "", /^text\/javascript/, path);
      assert.doesNotMatch(await module.text(), /import type|: Uint8Array\b|: StatusSnapshot\b|: StatusPageState\b/, `${path}: types are stripped`);
    }
    // The browser resolves view.js's import of the rules against the page; here it points at the served copy.
    const rulesUrl = `data:text/javascript,${encodeURIComponent(await (await fetch(`${base}/src/control-rules.ts`)).text())}`;
    const viewSource = (await (await fetch(`${base}/view.js`)).text()).replace('"../src/control-rules.ts"', JSON.stringify(rulesUrl));
    const viewModule = (await import(`data:text/javascript,${encodeURIComponent(viewSource)}`)) as Record<string, unknown>;
    assert.equal(typeof viewModule.dashboardView, "function", "the stripped view module loads in plain JavaScript");

    const theme = await fetch(`${base}/theme.js`);
    assert.equal(theme.status, 200);
    assert.match(theme.headers.get("content-type") ?? "", /^text\/javascript/);
    const themeSource = await theme.text();
    assert.doesNotMatch(themeSource, /: string \| null\b/, "types are stripped");
    assert.doesNotMatch(themeSource, /^\s*(import|export)\b/m, "the theme bootstrap is a classic script");
    assert.doesNotThrow(() => new Function(themeSource), "the stripped theme script parses");

    const worker = await fetch(`${base}/sw.js`);
    assert.equal(worker.status, 200);
    assert.match(worker.headers.get("content-type") ?? "", /^text\/javascript/);
    assert.doesNotMatch(await worker.text(), /^\s*(import|export)\b/m, "the service worker is a classic script");

    const manifest = await fetch(`${base}/manifest.webmanifest`);
    assert.equal(manifest.status, 200);
    assert.match(manifest.headers.get("content-type") ?? "", /^application\/manifest\+json/);
    const { icons, start_url, display } = (await manifest.json()) as { icons: { src: string; type: string }[]; start_url: string; display: string };
    assert.equal(start_url, "/");
    assert.equal(display, "standalone");
    for (const icon of icons) {
      const response = await fetch(`${base}${icon.src}`);
      assert.equal(response.status, 200, icon.src);
      assert.equal(response.headers.get("content-type"), icon.type, icon.src);
    }

    const styles = await fetch(`${base}/style.css`);
    assert.equal(styles.status, 200);
    assert.match(styles.headers.get("content-type") ?? "", /^text\/css/);
  });

  it("serves nothing else from the web directory, and the API still needs the token", async () => {
    for (const path of ["/app.ts", "/index.html", "/tsconfig.json", "/../package.json"]) {
      assert.equal((await fetch(`${base}${path}`)).status, 401, path);
      assert.equal((await fetch(`${base}${path}`, { headers: { Authorization: "Bearer secret" } })).status, 404, path);
    }
    assert.equal((await fetch(`${base}/api/status`)).status, 401);
  });
});

describe("HTTP API optional font files", () => {
  let server: Server;
  let base: string;
  let webDir: string;

  beforeEach(async () => {
    webDir = await mkdtemp(join(tmpdir(), "ecc-web-"));
    await mkdir(join(webDir, "fonts"));
    await writeFile(join(webDir, "fonts", "satoshi-500.woff2"), "wOF2 test font");
    const store = new StatusStore();
    const control = new PrintControl({ send: () => Promise.reject(new NotConnectedError()) }, store);
    const dashboard = dashboardFiles(pathToFileURL(webDir));
    server = createApiServer({ store, control, token: "secret", dashboard, logger: quiet });
    base = await listen(server);
  });

  afterEach(async () => {
    await closeServer(server);
    await rm(webDir, { recursive: true, force: true });
  });

  it("answers 404 without the token for a font the operator has not fetched", async () => {
    for (const path of ["/fonts/satoshi-400.woff2", "/fonts/satoshi-700.woff2", "/fonts/cabinet-grotesk-800.woff2"]) {
      assert.equal((await fetch(`${base}${path}`)).status, 404, path);
    }
  });

  it("serves a fetched font without the token as font/woff2", async () => {
    const font = await fetch(`${base}/fonts/satoshi-500.woff2`);
    assert.equal(font.status, 200);
    assert.equal(font.headers.get("content-type"), "font/woff2");
    assert.equal(await font.text(), "wOF2 test font");

    const head = await fetch(`${base}/fonts/satoshi-500.woff2`, { method: "HEAD" });
    assert.equal(head.status, 200, "HEAD answers like GET, so curl -I can check a font");
    assert.equal(head.headers.get("content-type"), "font/woff2");
    assert.equal(await head.text(), "");
  });
});
