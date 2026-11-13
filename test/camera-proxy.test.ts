import { strict as assert } from "node:assert";
import { once } from "node:events";
import { type ClientRequest, get, type IncomingMessage, type Server } from "node:http";
import { type AddressInfo, createServer as createTcpServer, type Socket } from "node:net";
import { afterEach, beforeEach, describe, it } from "node:test";
import { CameraProxy, delimiterOf } from "../src/camera-proxy.ts";
import { createApiServer } from "../src/http-server.ts";
import type { Logger } from "../src/sdcp-client.ts";
import { StatusStore } from "../src/status-store.ts";
import { FAKE_BOUNDARY, FakeMjpegSource } from "./support/fake-mjpeg.ts";

const quiet: Logger = { info: () => {}, warn: () => {}, error: () => {} };

/** Polls `condition` every 5 ms for up to 2 s. */
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
}

/** One browser-like viewer of `/camera`. */
class Viewer {
  readonly request: ClientRequest;
  response!: IncomingMessage;
  data = Buffer.alloc(0);

  private constructor(request: ClientRequest) {
    this.request = request;
  }

  static async open(url: string): Promise<Viewer> {
    const request = get(url);
    const viewer = new Viewer(request);
    request.on("error", () => {});
    [viewer.response] = (await once(request, "response")) as [IncomingMessage];
    viewer.response.on("data", (chunk: Buffer) => (viewer.data = Buffer.concat([viewer.data, chunk])));
    viewer.response.on("error", () => {});
    return viewer;
  }

  /** Waits until at least `count` whole parts have arrived. */
  async waitForParts(count: number): Promise<void> {
    await until(() => this.text.split(`--${FAKE_BOUNDARY}`).length - 1 > count, `${count} parts`);
  }

  get text(): string {
    return this.data.toString("latin1");
  }

  close(): void {
    this.request.destroy();
  }
}

describe("CameraProxy with a fake MJPEG source", () => {
  let source: FakeMjpegSource;
  let proxy: CameraProxy;
  let server: Server;
  let base: string;
  let prepared: number;

  async function start(
    options: { token?: string | null; url?: string; beforeConnect?: () => Promise<unknown>; maxBacklogBytes?: number; responseTimeoutMs?: number; logger?: Logger } = {},
  ): Promise<void> {
    prepared = 0;
    proxy = new CameraProxy({
      url: options.url ?? source.url,
      logger: options.logger ?? quiet,
      maxBacklogBytes: options.maxBacklogBytes,
      responseTimeoutMs: options.responseTimeoutMs,
      beforeConnect:
        options.beforeConnect ??
        (async () => {
          prepared++;
        }),
    });
    server = createApiServer({
      store: new StatusStore(),
      control: {} as never,
      token: options.token ?? null,
      camera: proxy,
      logger: quiet,
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  beforeEach(async () => {
    source = await FakeMjpegSource.start();
  });

  afterEach(async () => {
    proxy.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await source.close();
  });

  it("serves two viewers from one upstream connection, each starting at a part boundary", async () => {
    await start();
    const first = await Viewer.open(`${base}/camera`);
    assert.equal(first.response.statusCode, 200);
    assert.equal(first.response.headers["content-type"], `multipart/x-mixed-replace; boundary=${FAKE_BOUNDARY}`);
    await first.waitForParts(2);

    const second = await Viewer.open(`${base}/camera`);
    assert.equal(second.response.statusCode, 200);
    await second.waitForParts(2);
    await first.waitForParts(4);

    assert.equal(source.connections, 1);
    assert.equal(source.open.size, 1);
    assert.equal(proxy.upstreamConnections, 1);
    assert.equal(prepared, 1, "the stream is prepared once per upstream connection");
    for (const viewer of [first, second]) {
      assert.ok(viewer.text.startsWith(`--${FAKE_BOUNDARY}\r\n`), "starts with a whole part");
      assert.match(viewer.text, /frame-\d+/);
    }
    first.close();
    second.close();
  });

  it("keeps the upstream while a viewer remains and closes it when the last one leaves", async () => {
    await start();
    const first = await Viewer.open(`${base}/camera`);
    const second = await Viewer.open(`${base}/camera`);
    await first.waitForParts(1);

    first.close();
    await until(() => proxy.viewerCount === 1, "one viewer left");
    const before = second.data.length;
    await until(() => second.data.length > before, "frames after the first viewer left");
    assert.equal(source.open.size, 1);

    second.close();
    await source.waitForNoStreams();
    assert.equal(proxy.upstreamOpen, false);
    assert.equal(proxy.viewerCount, 0);

    const third = await Viewer.open(`${base}/camera`);
    await third.waitForParts(1);
    assert.equal(source.connections, 2, "a new viewer opens a new upstream");
    third.close();
    await source.waitForNoStreams();
  });

  it("still connects when preparing the stream fails", async () => {
    await start({ beforeConnect: () => Promise.reject(new Error("not connected")) });
    const viewer = await Viewer.open(`${base}/camera`);
    await viewer.waitForParts(1);
    viewer.close();
  });

  it("answers 502 when the camera answers an error status", async () => {
    source.status = 503;
    await start();
    const viewer = await Viewer.open(`${base}/camera`);
    assert.equal(viewer.response.statusCode, 502);
    await once(viewer.response, "end");
    assert.equal(JSON.parse(viewer.text).error.code, "camera-unavailable");
    assert.equal(proxy.upstreamOpen, false);
  });

  it("answers 502 when the camera is unreachable", async () => {
    const url = source.url;
    await source.close();
    await start({ url });
    const viewer = await Viewer.open(`${base}/camera`);
    assert.equal(viewer.response.statusCode, 502);
    await once(viewer.response, "end");
    assert.equal(JSON.parse(viewer.text).error.code, "camera-unavailable");
    source = await FakeMjpegSource.start(); // for afterEach
  });

  it("answers 502 when the camera accepts the connection but never answers", async () => {
    // A camera that takes the TCP connection and sends nothing back.
    const sockets = new Set<Socket>();
    const silent = createTcpServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => sockets.delete(socket));
      socket.resume(); // reads (and drops) the request, so the proxy's hang-up is seen
    });
    silent.listen(0, "127.0.0.1");
    await once(silent, "listening");
    try {
      const warnings: string[] = [];
      await start({
        url: `http://127.0.0.1:${(silent.address() as AddressInfo).port}/video`,
        responseTimeoutMs: 200,
        logger: { ...quiet, warn: (message: string) => warnings.push(message) },
      });
      const started = Date.now();
      const viewer = await Viewer.open(`${base}/camera`);
      assert.equal(viewer.response.statusCode, 502);
      await once(viewer.response, "end");
      assert.ok(Date.now() - started < 2000, "fails at the timeout, not later");
      assert.equal(JSON.parse(viewer.text).error.code, "camera-unavailable");
      assert.ok(warnings.some((w) => /did not answer within 200 ms/.test(w)), "the timeout is logged");
      assert.equal(proxy.upstreamOpen, false);
      await until(() => sockets.size === 0, "the upstream socket closed");
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => silent.close(() => resolve()));
    }
  });

  it("does not time out a camera that answered in time", async () => {
    await start({ responseTimeoutMs: 200 });
    const viewer = await Viewer.open(`${base}/camera`);
    await viewer.waitForParts(1);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const before = viewer.data.length;
    await until(() => viewer.data.length > before, "frames after the timeout would have fired");
    assert.equal(viewer.response.statusCode, 200);
    viewer.close();
  });

  it("ends viewers when the upstream stream ends", async () => {
    await start();
    const viewer = await Viewer.open(`${base}/camera`);
    await viewer.waitForParts(1);
    for (const res of source.open) res.end();
    await once(viewer.response, "end");
    assert.equal(proxy.upstreamOpen, false);
  });

  it("drops a viewer that stops reading once its backlog passes the cap, and keeps the others", async () => {
    await source.close();
    source = await FakeMjpegSource.start({ frameIntervalMs: 1, framePadBytes: 32 * 1024 });
    const warnings: string[] = [];
    await start({ maxBacklogBytes: 256 * 1024, logger: { ...quiet, warn: (message: string) => warnings.push(message) } });

    const slow = await Viewer.open(`${base}/camera`);
    await slow.waitForParts(1);
    slow.response.pause(); // never reads again, so the kernel buffers fill and the proxy backlog grows
    const slowClosed = new Promise((resolve) => slow.response.on("close", resolve)); // closes with an "aborted" error

    // A viewer that keeps reading, counting bytes only.
    const fast = get(`${base}/camera`);
    fast.on("error", () => {});
    const [fastResponse] = (await once(fast, "response")) as [IncomingMessage];
    let fastBytes = 0;
    fastResponse.on("data", (chunk: Buffer) => (fastBytes += chunk.length));

    for (let i = 0; i < 2000 && proxy.viewerCount > 1; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(proxy.viewerCount, 1, "the slow viewer was dropped");
    assert.ok(warnings.some((w) => /cannot keep up/.test(w)), "the drop is logged");
    slow.response.resume();
    await slowClosed;

    const before = fastBytes;
    await until(() => fastBytes > before, "frames for the reading viewer after the drop");
    assert.equal(proxy.upstreamConnections, 1, "the upstream stays open for the reading viewer");
    fast.destroy();
    await source.waitForNoStreams();
  });

  it("requires the token, which a query parameter can carry for <img>", async () => {
    await start({ token: "cam-token" });
    const denied = await Viewer.open(`${base}/camera`);
    assert.equal(denied.response.statusCode, 401);
    assert.equal(source.connections, 0, "nothing reached the camera");
    const viewer = await Viewer.open(`${base}/camera?token=cam-token`);
    assert.equal(viewer.response.statusCode, 200);
    await viewer.waitForParts(1);
    viewer.close();
  });
});

describe("delimiterOf", () => {
  it("reads plain and quoted boundaries", () => {
    assert.deepEqual(delimiterOf("multipart/x-mixed-replace; boundary=foo"), Buffer.from("--foo"));
    assert.deepEqual(delimiterOf('multipart/x-mixed-replace;boundary="a b"'), Buffer.from("--a b"));
    assert.equal(delimiterOf("image/jpeg"), null);
    assert.equal(delimiterOf(undefined), null);
  });
});
