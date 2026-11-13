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
}

const WEB_DIR = new URL("../web/", import.meta.url);

/** URL path to file. Only these paths are served; nothing else in `web/` is reachable. */
const FILES: Record<string, PublicFile> = {
  "/": { source: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { source: "app.ts", type: "text/javascript; charset=utf-8", typescript: true },
  "/style.css": { source: "style.css", type: "text/css; charset=utf-8" },
};

/** Serves the dashboard's files (see FILES). */
export interface StaticFiles {
  has(path: string): boolean;
  serve(path: string, res: ServerResponse): Promise<void>;
}

export function dashboardFiles(): StaticFiles {
  return {
    has: (path) => Object.hasOwn(FILES, path),
    async serve(path, res) {
      const file = FILES[path];
      if (file === undefined) throw new Error(`no dashboard file for ${path}`);
      const raw = await readFile(new URL(file.source, WEB_DIR));
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
