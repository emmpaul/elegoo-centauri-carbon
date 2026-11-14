// The dashboard's service worker (web/sw.ts), run as the classic script the
// service serves, against stand-ins for the worker scope, the Cache API, and
// fetch: what it pre-caches, its font and shell strategies, and that every
// path it names is one the service serves.
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, describe, it } from "node:test";
import { dashboardFiles } from "../src/dashboard-files.ts";
import { createApiServer } from "../src/http-server.ts";
import { PrintControl } from "../src/print-control.ts";
import { type Logger, NotConnectedError } from "../src/sdcp-client.ts";
import { StatusStore } from "../src/status-store.ts";

const ORIGIN = "https://printer.test";
const WEB = new URL("../web/", import.meta.url);
const SOURCE = stripTypeScriptTypes(await readFile(new URL("sw.ts", WEB), "utf8"));

type Listener = (event: unknown) => void;

/** Runs the worker script once with fresh stand-ins; `network` answers its fetches. */
function worker(network: (url: string) => Promise<Response>) {
  const listeners = new Map<string, Listener>();
  const stored = new Map<string, Response>();
  const fetched: string[] = [];
  let preCached: string[] = [];
  const cache = {
    addAll: (paths: string[]) => {
      preCached = paths;
      return Promise.resolve();
    },
    put: (key: string, response: Response) => {
      stored.set(key, response);
      return Promise.resolve();
    },
  };
  const caches = {
    open: () => Promise.resolve(cache),
    match: (key: string) => Promise.resolve(stored.get(key)?.clone()),
    keys: () => Promise.resolve([]),
    delete: () => Promise.resolve(true),
  };
  const scope = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, listener: Listener) => void listeners.set(type, listener),
    skipWaiting: () => Promise.resolve(),
    clients: { claim: () => Promise.resolve() },
  };
  const fetchStub = (request: { url: string }) => {
    fetched.push(new URL(request.url).pathname);
    return network(request.url);
  };
  const names = new Function("self", "caches", "fetch", `${SOURCE}\nreturn { SHELL, FONTS };`)(scope, caches, fetchStub) as { SHELL: string[]; FONTS: string[] };

  /** Dispatches a fetch event; resolves to the worker's answer, or null when it leaves the request alone. */
  async function request(path: string, method = "GET"): Promise<Response | null> {
    let answer: Promise<Response> | null = null;
    listeners.get("fetch")!({ request: { url: `${ORIGIN}${path}`, method }, respondWith: (p: Promise<Response>) => void (answer = p) });
    const response = answer === null ? null : await answer;
    await new Promise((resolve) => setImmediate(resolve)); // the cache.put after the answer
    return response;
  }
  async function install(): Promise<string[]> {
    let done: Promise<unknown> = Promise.resolve();
    listeners.get("install")!({ waitUntil: (p: Promise<unknown>) => void (done = p) });
    await done;
    return preCached;
  }
  return { ...names, stored, fetched, request, install };
}

const ok = (body: string) => () => Promise.resolve(new Response(body));

describe("service worker", () => {
  it("pre-caches exactly the shell, never the optional fonts", async () => {
    const sw = worker(ok("x"));
    const preCached = await sw.install();
    assert.deepEqual(preCached, sw.SHELL);
    for (const font of sw.FONTS) assert.equal(preCached.includes(font), false, font);
  });

  it("serves a font from the network once, then from the cache", async () => {
    const sw = worker(ok("font"));
    const font = sw.FONTS[0]!;
    assert.equal(await (await sw.request(font))!.text(), "font");
    assert.ok(sw.stored.has(font), "stored after the first load");
    assert.equal(await (await sw.request(font))!.text(), "font");
    assert.deepEqual(sw.fetched, [font], "the second load does not touch the network");
  });

  it("never caches a font the service answers 404 for, so it loads once fetched", async () => {
    let status = 404;
    const sw = worker(() => Promise.resolve(new Response("", { status })));
    const font = sw.FONTS[0]!;
    assert.equal((await sw.request(font))!.status, 404);
    assert.equal(sw.stored.has(font), false);
    status = 200;
    assert.equal((await sw.request(font))!.status, 200);
    assert.deepEqual(sw.fetched, [font, font]);
  });

  it("serves the shell from the network first, and the cached copy when the service can't be reached", async () => {
    let up = true;
    const sw = worker(() => (up ? Promise.resolve(new Response("page v2")) : Promise.reject(new TypeError("fetch failed"))));
    assert.equal(await (await sw.request("/"))!.text(), "page v2");
    up = false;
    assert.equal(await (await sw.request("/"))!.text(), "page v2", "the copy stored on the last load");
  });

  it("keeps the cached shell when the service answers an error", async () => {
    let status = 200;
    const sw = worker(() => Promise.resolve(new Response(`status ${status}`, { status })));
    await sw.request("/app.js");
    status = 503;
    assert.equal((await sw.request("/app.js"))!.status, 503);
    assert.equal(await sw.stored.get("/app.js")!.text(), "status 200");
  });

  it("leaves the API, the camera, other methods, and other origins alone", async () => {
    const sw = worker(ok("x"));
    for (const path of ["/api/status", "/api/events", "/camera"]) assert.equal(await sw.request(path), null, path);
    assert.equal(await sw.request("/", "POST"), null);
    assert.deepEqual(sw.fetched, []);
  });
});

describe("service worker paths against the served files", () => {
  const quiet: Logger = { info: () => {}, warn: () => {}, error: () => {} };
  const servers: Server[] = [];
  let full = "";
  let bare = "";
  let emptyDir = "";

  const serve = async (webDir?: URL): Promise<string> => {
    const store = new StatusStore();
    const control = new PrintControl({ send: () => Promise.reject(new NotConnectedError()) }, store);
    const server = createApiServer({ store, control, token: "secret", dashboard: dashboardFiles(webDir), logger: quiet });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };

  before(async () => {
    full = await serve();
    emptyDir = await mkdtemp(join(tmpdir(), "ecc-web-"));
    bare = await serve(pathToFileURL(emptyDir));
  });

  after(async () => {
    for (const server of servers) await new Promise((resolve) => server.close(resolve));
    await rm(emptyDir, { recursive: true, force: true });
  });

  it("every shell path is served without the token, so the install never fails", async () => {
    const { SHELL } = worker(ok("x"));
    for (const path of SHELL) assert.equal((await fetch(`${full}${path}`)).status, 200, path);
  });

  it("every font path is a dashboard file the operator may leave out (404, not 401 or 500)", async () => {
    const { FONTS } = worker(ok("x"));
    assert.ok(FONTS.length > 0);
    for (const path of FONTS) assert.equal((await fetch(`${bare}${path}`)).status, 404, path);
  });

  it("the shell holds every module the page loads", async () => {
    const { SHELL } = worker(ok("x"));
    const seen = new Set<string>();
    const visit = async (file: string): Promise<void> => {
      if (seen.has(file)) return;
      seen.add(file);
      const source = await readFile(new URL(file, WEB), "utf8");
      for (const [, specifier = ""] of source.matchAll(/^import (?!type\b)[^"]*"([^"]+)";$/gm)) {
        if (specifier.startsWith("./")) await visit(specifier.slice(2).replace(/\.js$/, ".ts"));
        else if (specifier === "../src/control-rules.ts") seen.add("/src/control-rules.ts");
      }
    };
    await visit("app.ts");
    const served = [...seen].map((file) => (file.startsWith("/") ? file : `/${file.replace(/\.ts$/, ".js")}`));
    for (const path of served) assert.ok(SHELL.includes(path), `${path} is in the shell`);
    assert.ok(served.includes("/commands.js") && served.includes("/view.js"), "the walk found the page's modules");
  });
});
