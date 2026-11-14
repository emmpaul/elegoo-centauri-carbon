// Downloads the dashboard's typefaces, Satoshi (400, 500, 700) and Cabinet
// Grotesk (800), from Fontshare into web/fonts/ (design D2). Run it with
// `pnpm fonts:fetch`. The files are under the ITF Free Font License, which lets
// you self-host your own copy but forbids redistributing them, so they are never
// committed (web/fonts/ is in .gitignore and .dockerignore). Each weight's
// official woff2 file is saved unchanged. Without them the page uses system fonts.
import { mkdir, writeFile } from "node:fs/promises";

// One request per family: the CSS API answers only the first `f[]` of a request.
const CSS_URLS = [
  "https://api.fontshare.com/v2/css?f[]=satoshi@400,500,700&display=swap",
  "https://api.fontshare.com/v2/css?f[]=cabinet-grotesk@800&display=swap",
];
const LICENSE_URL = "https://www.fontshare.com/licenses/itf-ffl";
const FONTS_DIR = new URL("../web/fonts/", import.meta.url);

/** Family and weight as Fontshare names them, to the file name the dashboard serves. */
const WANTED: Record<string, string> = {
  "Satoshi 400": "satoshi-400.woff2",
  "Satoshi 500": "satoshi-500.woff2",
  "Satoshi 700": "satoshi-700.woff2",
  "Cabinet Grotesk 800": "cabinet-grotesk-800.woff2",
};

async function get(url: string): Promise<Response> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response;
}

/** The woff2 URL of each `@font-face` rule in the CSS, keyed by "<family> <weight>". */
function woff2Urls(css: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const [, rule] of css.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    const family = /font-family:\s*'([^']+)'/.exec(rule ?? "")?.[1];
    const weight = /font-weight:\s*(\d+)/.exec(rule ?? "")?.[1];
    const url = /url\('([^']+\.woff2)'\)\s*format\('woff2'\)/.exec(rule ?? "")?.[1];
    if (family && weight && url) found.set(`${family} ${weight}`, new URL(url, "https://api.fontshare.com/").href);
  }
  return found;
}

async function main(): Promise<void> {
  const urls = new Map<string, string>();
  for (const cssUrl of CSS_URLS) {
    for (const [face, url] of woff2Urls(await (await get(cssUrl)).text())) urls.set(face, url);
  }
  await mkdir(FONTS_DIR, { recursive: true });
  for (const [face, file] of Object.entries(WANTED)) {
    const url = urls.get(face);
    if (url === undefined) throw new Error(`Fontshare's CSS has no woff2 file for ${face}`);
    const body = Buffer.from(await (await get(url)).arrayBuffer());
    if (body.subarray(0, 4).toString("latin1") !== "wOF2") throw new Error(`${url} is not a woff2 file`);
    await writeFile(new URL(file, FONTS_DIR), body);
    console.log(`saved web/fonts/${file} (${face}, ${body.length} bytes)`);
  }
  console.log(`These fonts are for your own self-hosted dashboard only; do not redistribute them. Licence: ${LICENSE_URL}`);
}

main().catch((error: unknown) => {
  console.error(`fonts:fetch failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
