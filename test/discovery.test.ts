import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findCli, findLocalServer, runBackgroundService } from "../src/connection/discovery.ts";

// An explicit CLI path wins over discovery; agents running under T3 Code have one set.
delete process.env.T3CODE_CLI_PATH;

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

test("a runtime file written by t3 service marks the local server as service-managed", () => {
  const t3Home = home();
  mkdirSync(join(t3Home, "userdata"));
  const runtime = { version: 1, pid: process.pid, port: 3773, serviceManaged: true, serverVersion: "0.1.8" };
  writeFileSync(join(t3Home, "userdata", "server-runtime.json"), JSON.stringify(runtime));
  assert.deepEqual(findLocalServer(t3Home), { httpBaseUrl: "http://127.0.0.1:3773", serverVersion: "0.1.8", t3Home, serviceManaged: true });
  writeFileSync(join(t3Home, "userdata", "server-runtime.json"), JSON.stringify({ ...runtime, serviceManaged: undefined }));
  assert.equal(findLocalServer(t3Home)?.serviceManaged, false);
});

test("the background service runs through the t3 CLI with this T3 home, and reports its last line on failure", { skip: process.platform === "win32" }, async () => {
  const t3Home = home();
  const cli = join(t3Home, "fake-t3");
  writeFileSync(cli, '#!/bin/sh\necho "args=$* home=$T3CODE_HOME"\n[ "$2" = install ] || { echo "Service is not installed" >&2; exit 1; }\n');
  chmodSync(cli, 0o755);
  assert.equal(await runBackgroundService(cli, t3Home, "install"), `args=service install home=${t3Home}`);
  await assert.rejects(runBackgroundService(cli, t3Home, "uninstall"), /Service is not installed/);
});
