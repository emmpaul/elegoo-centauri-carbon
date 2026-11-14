// Renders the dashboard's install icons from web/icons/icon.svg (design D13)
// into web/icons/, with Chromium through playwright-core. The PNGs are
// committed; run this again after changing icon.svg.
//
// Usage:
//   node scripts/render-icons.ts
//
// Output (web/icons/):
//   icon-192.png            the 48 design (icon.svg's small-size media query) at 4×
//   icon-512.png            the 512 design
//   icon-maskable-512.png   the 512 design, full bleed (the bars sit inside the 80 % safe circle)
//   apple-touch-icon.png    180: the design's 90 px drawing at 2×
//
// Environment:
//   CHROMIUM_PATH  Chromium executable (default: playwright-core's own lookup)
import { readFile, writeFile } from "node:fs/promises";
import { type Browser, chromium } from "playwright-core";

const ICONS = new URL("../web/icons/", import.meta.url);

/** One PNG: drawn at `css` CSS pixels and `scale` device pixels per CSS pixel. */
interface Icon {
  file: string;
  css: number;
  scale: number;
  /** Square corners, for launchers that apply their own mask. */
  fullBleed?: boolean;
}

// icon.svg picks its geometry from the size it is drawn at, so each PNG is drawn
// at the size the design shows it at and scaled up with the device pixel ratio.
const ICON_SET: Icon[] = [
  { file: "icon-192.png", css: 48, scale: 4 },
  { file: "icon-512.png", css: 512, scale: 1 },
  { file: "icon-maskable-512.png", css: 512, scale: 1, fullBleed: true },
  { file: "apple-touch-icon.png", css: 90, scale: 2 },
];

/** Square corners for the maskable icon: a rule appended to the SVG's own stylesheet. */
const FULL_BLEED = ".tile { rx: 0 !important; ry: 0 !important; }";

async function renderIcon(browser: Browser, svg: string, icon: Icon): Promise<Buffer> {
  const source = icon.fullBleed ? svg.replace("</style>", `  ${FULL_BLEED}\n  </style>`) : svg;
  const context = await browser.newContext({ viewport: { width: icon.css, height: icon.css }, deviceScaleFactor: icon.scale });
  try {
    const page = await context.newPage();
    const src = `data:image/svg+xml;base64,${Buffer.from(source).toString("base64")}`;
    await page.setContent(`<!doctype html><style>html,body{margin:0;background:transparent}img{display:block}</style><img src="${src}" width="${icon.css}" height="${icon.css}" alt="">`);
    await page.locator("img").evaluate((img: any) => img.decode());
    return await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: icon.css, height: icon.css } });
  } finally {
    await context.close();
  }
}

const svg = await readFile(new URL("icon.svg", ICONS), "utf8");
if (!svg.includes("</style>")) throw new Error("web/icons/icon.svg has no <style> element");
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  for (const icon of ICON_SET) {
    await writeFile(new URL(icon.file, ICONS), await renderIcon(browser, svg, icon));
    console.log(`web/icons/${icon.file}  ${icon.css * icon.scale} × ${icon.css * icon.scale}`);
  }
} finally {
  await browser.close();
}
