// Lets `node --test` load the dashboard's browser modules (web/*.ts). They
// import their siblings as `./view.js`, the path the service serves them at;
// this resolve hook maps such an import from web/ to the `.ts` source. Import
// this module first, then the web modules with a dynamic `import()`, since
// static imports resolve before any module body runs.
import { registerHooks } from "node:module";

const WEB_DIR = new URL("../../web/", import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(WEB_DIR) && /^\.\/[\w-]+\.js$/.test(specifier)) {
      return nextResolve(specifier.replace(/\.js$/, ".ts"), context);
    }
    return nextResolve(specifier, context);
  },
});
