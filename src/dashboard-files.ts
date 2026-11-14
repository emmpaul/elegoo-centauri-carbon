// Static files of the dashboard (`web/`). TypeScript sources are served as
// JavaScript with their types stripped at request time, so the dashboard has
// no build step either (design D2). These files hold no printer data, so they
// are served without the access token; the page asks for the token itself and
// sends it with every API and camera request.
import { readFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { stripTypeScriptTypes } from "node:module";

/** A public file: its source in `web/`, the content type, and whether to strip types. */
interface PublicFile {
  source: string;
  type: string;
  typescript?: boolean;
  /** The operator may leave it out (the fonts, design D2): when missing it answers 404. */
  optional?: boolean;
}

const WEB_DIR = new URL("../web/", import.meta.url);
const WOFF2 = "font/woff2";

/** URL path to file. Only these paths are served; nothing else in `web/` is reachable. */
const FILES: Record<string, PublicFile> = {
  "/": { source: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { source: "app.ts", type: "text/javascript; charset=utf-8", typescript: true },
  "/mjpeg.js": { source: "mjpeg.ts", type: "text/javascript; charset=utf-8", typescript: true },
  "/view.js": { source: "view.ts", type: "text/javascript; charset=utf-8", typescript: true },
  "/style.css": { source: "style.css", type: "text/css; charset=utf-8" },
  "/sw.js": { source: "sw.ts", type: "text/javascript; charset=utf-8", typescript: true },
  "/manifest.webmanifest": { source: "manifest.webmanifest", type: "application/manifest+json; charset=utf-8" },
  "/icons/icon.svg": { source: "icons/icon.svg", type: "image/svg+xml" },
  "/icons/icon-192.png": { source: "icons/icon-192.png", type: "image/png" },
  "/icons/icon-512.png": { source: "icons/icon-512.png", type: "image/png" },
  "/icons/icon-maskable-512.png": { source: "icons/icon-maskable-512.png", type: "image/png" },
  "/icons/apple-touch-icon.png": { source: "icons/apple-touch-icon.png", type: "image/png" },
  // Fetched by the operator with `pnpm fonts:fetch`, never committed (design D2).
  "/fonts/satoshi-400.woff2": { source: "fonts/satoshi-400.woff2", type: WOFF2, optional: true },
  "/fonts/satoshi-500.woff2": { source: "fonts/satoshi-500.woff2", type: WOFF2, optional: true },
  "/fonts/satoshi-700.woff2": { source: "fonts/satoshi-700.woff2", type: WOFF2, optional: true },
  "/fonts/cabinet-grotesk-800.woff2": { source: "fonts/cabinet-grotesk-800.woff2", type: WOFF2, optional: true },
  // The control rules the command layer enforces, so the page enables the same buttons.
  "/src/control-rules.ts": { source: "../src/control-rules.ts", type: "text/javascript; charset=utf-8", typescript: true },
};

/** Serves the dashboard's files (see FILES). */
export interface StaticFiles {
  has(path: string): boolean;
  serve(path: string, res: ServerResponse): Promise<void>;
}

/** `webDir` defaults to the repository's `web/`; tests point it at a temporary copy. */
export function dashboardFiles(webDir: URL = WEB_DIR): StaticFiles {
  const dir = webDir.href.endsWith("/") ? webDir : new URL(`${webDir.href}/`);
  return {
    has: (path) => Object.hasOwn(FILES, path),
    async serve(path, res) {
      const file = FILES[path];
      if (file === undefined) throw new Error(`no dashboard file for ${path}`);
      let raw: Buffer;
      try {
        raw = await readFile(new URL(file.source, dir));
      } catch (error) {
        if (!file.optional || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" });
        res.end("Not found\n");
        return;
      }
      const body = file.typescript ? Buffer.from(stripTypeScriptTypes(raw.toString("utf8"))) : raw;
      res.writeHead(200, {
        "Content-Type": file.type,
        "Content-Length": body.length,
        // Always revalidate, so a restarted service never leaves an old page running.
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(body);
    },
  };
}
