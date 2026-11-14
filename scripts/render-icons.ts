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
//   splash-<w>x<h>.png      the g2 launch screen per current iPhone portrait size (device pixels),
//                           listed as apple-touch-startup-image links in web/index.html
//
// Environment:
//   CHROMIUM_PATH  Chromium executable (default: playwright-core's own lookup)
//
// The splash text is set in Satoshi and Cabinet Grotesk, so it needs the fonts
// (`pnpm fonts:fetch`). The PNGs are images made with the fonts, not the font files.
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { type Browser, chromium } from "playwright-core";

const ICONS = new URL("../web/icons/", import.meta.url);
const FONTS = new URL("../web/fonts/", import.meta.url);

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

/** An iPhone portrait screen: CSS size and device pixel ratio. */
export interface Splash {
  width: number;
  height: number;
  ratio: number;
}

/** Portrait screens of the iPhones current iOS supports (several models share each). */
export const SPLASHES: Splash[] = [
  { width: 375, height: 667, ratio: 2 }, // SE 2nd and 3rd generation
  { width: 414, height: 896, ratio: 2 }, // 11, XR
  { width: 375, height: 812, ratio: 3 }, // 11 Pro, 12 mini, 13 mini
  { width: 414, height: 896, ratio: 3 }, // 11 Pro Max
  { width: 390, height: 844, ratio: 3 }, // 12, 12 Pro, 13, 13 Pro, 14, 16e
  { width: 428, height: 926, ratio: 3 }, // 12 Pro Max, 13 Pro Max, 14 Plus
  { width: 393, height: 852, ratio: 3 }, // 14 Pro, 15, 15 Pro, 16
  { width: 430, height: 932, ratio: 3 }, // 14 Pro Max, 15 Plus, 15 Pro Max, 16 Plus
  { width: 402, height: 874, ratio: 3 }, // 16 Pro, 17, 17 Pro
  { width: 420, height: 912, ratio: 3 }, // Air
  { width: 440, height: 956, ratio: 3 }, // 16 Pro Max, 17 Pro Max
];

/** File name of a splash image: its size in device pixels. */
export const splashFile = (s: Splash) => `splash-${s.width * s.ratio}x${s.height * s.ratio}.png`;

/** The g2 launch screen: the app mark, "Printer", and the printer model, centred on #0f0f0f. */
function splashPage(fonts: Record<string, string>): string {
  const face = (family: string, weight: number, file: string) =>
    `@font-face{font-family:'${family}';font-weight:${weight};src:url(data:font/woff2;base64,${fonts[file]}) format('woff2')}`;
  return `<!doctype html><style>
${face("Satoshi", 400, "satoshi-400")}
${face("Cabinet Grotesk", 800, "cabinet-grotesk-800")}
html,body{margin:0;height:100%;background:#0f0f0f}
.splash{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;font-family:'Satoshi',ui-sans-serif,system-ui,sans-serif;color:#ececec}
.mark{width:96px;height:96px;border-radius:22px;background:linear-gradient(180deg,#222,#151515);box-shadow:inset 0 1px 0 rgba(255,255,255,0.1),0 12px 30px rgba(0,0,0,0.6);display:flex;flex-direction:column;justify-content:flex-end;gap:6px;padding:0 24px 25px;box-sizing:border-box}
.mark span{width:100%;height:10px;border-radius:3px;background:#6fd7a8}
.mark span:first-child{width:58%;background:#8b8b8b}
.words{display:flex;flex-direction:column;align-items:center;gap:4px}
.name{font-family:'Cabinet Grotesk','Satoshi',sans-serif;font-size:24px;font-weight:800;letter-spacing:-0.01em}
.model{font-size:13.5px;color:#8b8b8b}
</style><div class="splash"><div class="mark"><span></span><span></span><span></span></div><div class="words"><span class="name">Printer</span><span class="model">Centauri Carbon</span></div></div>`;
}

async function renderSplash(browser: Browser, html: string, splash: Splash): Promise<Buffer> {
  const context = await browser.newContext({ viewport: { width: splash.width, height: splash.height }, deviceScaleFactor: splash.ratio });
  try {
    const page = await context.newPage();
    await page.setContent(html);
    await page.evaluate(() => (globalThis as any).document.fonts.ready.then(() => true));
    return await page.screenshot();
  } finally {
    await context.close();
  }
}

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

async function main(): Promise<void> {
  const svg = await readFile(new URL("icon.svg", ICONS), "utf8");
  if (!svg.includes("</style>")) throw new Error("web/icons/icon.svg has no <style> element");
  const fonts: Record<string, string> = {};
  for (const name of ["satoshi-400", "cabinet-grotesk-800"]) {
    const file = new URL(`${name}.woff2`, FONTS);
    if (!existsSync(file)) throw new Error(`web/fonts/${name}.woff2 is missing: run pnpm fonts:fetch first (the splash text needs it)`);
    fonts[name] = (await readFile(file)).toString("base64");
  }
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  try {
    for (const icon of ICON_SET) {
      await writeFile(new URL(icon.file, ICONS), await renderIcon(browser, svg, icon));
      console.log(`web/icons/${icon.file}  ${icon.css * icon.scale} × ${icon.css * icon.scale}`);
    }
    const html = splashPage(fonts);
    for (const splash of SPLASHES) {
      await writeFile(new URL(splashFile(splash), ICONS), await renderSplash(browser, html, splash));
      console.log(`web/icons/${splashFile(splash)}  ${splash.width} × ${splash.height} at ${splash.ratio}×`);
    }
  } finally {
    await browser.close();
  }
}

// The harness imports SPLASHES; only a direct run renders.
if (import.meta.main) await main();
