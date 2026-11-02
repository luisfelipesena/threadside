import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { test } from "node:test";

// Loads the packaged bundle the way the editor does, with a stub `vscode`, so a dependency that
// cannot be bundled (dynamic requires, missing files) fails here instead of at activation.
test("the built extension bundle loads and exports activate", { skip: !existsSync("dist/extension.js") && "run npm run build first" }, () => {
  const stub = new Proxy({}, { get: () => new Proxy(function () {}, { get: () => ({}) }) });
  const load = (Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown })._load;
  (Module as unknown as { _load: unknown })._load = (request: string, ...rest: unknown[]) =>
    request === "vscode" ? stub : load(request, ...rest);
  try {
    const extension = createRequire(`${process.cwd()}/package.json`)("./dist/extension.js") as { activate?: unknown };
    assert.equal(typeof extension.activate, "function");
  } finally {
    (Module as unknown as { _load: unknown })._load = load;
  }
});
