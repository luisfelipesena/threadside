import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findCli } from "../src/connection/discovery.ts";

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "t3home-"));
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "bin", "t3"), "");
  return dir;
}

test("the CLI is the desktop app's copy when no background service is installed", () => {
  const t3Home = home();
  assert.equal(findCli(t3Home), join(t3Home, "bin", "t3"));
});

test("with t3 service installed, the CLI is the service's active runtime, matching the server", () => {
  const t3Home = home();
  const runtime = join(t3Home, "runtime", "versions", "0.1.8-nightly.20261104.4165");
  mkdirSync(runtime, { recursive: true });
  writeFileSync(join(runtime, "t3"), "");
  writeFileSync(join(t3Home, "runtime", "service-state.json"), JSON.stringify({ protocol: 3, activeVersion: "0.1.8-nightly.20261104.4165" }));
  assert.equal(findCli(t3Home), join(runtime, "t3"));
});

test("a service state naming a missing or unsafe version falls back to the desktop app's copy", () => {
  const t3Home = home();
  mkdirSync(join(t3Home, "runtime"));
  writeFileSync(join(t3Home, "runtime", "service-state.json"), JSON.stringify({ activeVersion: "../../evil" }));
  assert.equal(findCli(t3Home), join(t3Home, "bin", "t3"));
  writeFileSync(join(t3Home, "runtime", "service-state.json"), JSON.stringify({ activeVersion: "9.9.9" }));
  assert.equal(findCli(t3Home), join(t3Home, "bin", "t3"));
});
