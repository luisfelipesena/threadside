import { mkdirSync } from "node:fs";
import * as esbuild from "esbuild";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");
mkdirSync("dist", { recursive: true });

const extension = await esbuild.context({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["vscode"],
  // jsonc-parser's UMD entry requires its parts at runtime; its ESM entry bundles cleanly.
  mainFields: ["module", "main"],
  outfile: "dist/extension.js",
  sourcemap: production ? false : "linked",
  minify: production,
  logLevel: "info",
});
const bridge = await esbuild.context({
  entryPoints: ["bridge/bridge.js"],
  bundle: false,
  target: "chrome120",
  outfile: "dist/bridge.js",
  minify: production,
  logLevel: "info",
});

if (watch) {
  await Promise.all([extension.watch(), bridge.watch()]);
} else {
  await Promise.all([extension.rebuild(), bridge.rebuild()]);
  await Promise.all([extension.dispose(), bridge.dispose()]);
}
