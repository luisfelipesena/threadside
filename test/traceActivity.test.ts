import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { activityPath, failedItem, patchSpans, publicInsight, readSpans, resolveTracePath, traceItem, type TraceItem } from "../src/native/traceActivity.ts";
import { threadKeyFromPath } from "../src/routes.ts";

const item: TraceItem = { id: "item:1", threadId: "thread:A", type: "dynamic_tool", status: "completed", toolName: "Read", nativeDriver: "claudeAgent" };

test("routing retains environment and decodes prefixed thread ids exactly once", () => {
  assert.deepEqual(threadKeyFromPath("/ad9a2707-858c-4eca-906f-b45644605807/thread%3Achild%253A1?panel=files"), { environmentId: "ad9a2707-858c-4eca-906f-b45644605807", threadId: "thread:child%3A1" });
  assert.equal(threadKeyFromPath("/settings/general"), undefined);
});

test("malformed items and unknown tools do not become filesystem reads", () => {
  assert.equal(traceItem({ id: 1, type: "file_change" }), undefined);
  assert.equal(activityPath({ ...item, toolName: "mcp__mail__Read", input: { path: "/mail" } }), undefined);
  assert.equal(activityPath({ ...item, toolSource: { server: "unknown" }, input: { path: "/file" } }), undefined);
  assert.equal(activityPath({ ...item, nativeDriver: undefined, input: { path: "/file" } }), undefined);
  assert.equal(activityPath({ ...item, type: "command_execution", input: { cmd: "cat file.ts" } }), undefined);
});

test("observed Claude, Gemini, Grok and Pi read inputs preserve exact paths", () => {
  for (const [driver, input] of Object.entries({ claudeAgent: { file_path: "/code/a.ts" }, antigravity: { AbsolutePath: "/code/a.ts", path: "/code/a.ts" }, grok: { target_file: "/code/a.ts", path: "/code/a.ts" }, pi: { path: "/code/a.ts" } })) {
    const decoded = traceItem({ ...item, nativeItemRef: { driver }, input });
    assert.equal(activityPath(decoded!), "/code/a.ts");
  }
});

test("file resolution rejects traversal, lookalikes, missing paths and symlink escapes", async () => {
  const folder = await mkdtemp(join(tmpdir(), "threadside-trace-"));
  try {
    const root = join(folder, "repo");
    await mkdir(root);
    await mkdir(join(folder, "repo-other"));
    await writeFile(join(root, "same.ts"), "inside");
    await writeFile(join(folder, "repo-other", "same.ts"), "outside");
    await symlink(join(folder, "repo-other"), join(root, "escape"));
    assert.ok((await resolveTracePath("same.ts", root))?.endsWith("/repo/same.ts"));
    assert.equal(await resolveTracePath("../repo-other/same.ts", root), undefined);
    assert.equal(await resolveTracePath(join(folder, "repo-other", "same.ts"), root), undefined);
    assert.equal(await resolveTracePath("escape/same.ts", root), undefined);
    assert.equal(await resolveTracePath("missing.ts", root), undefined);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("status and explicit tool failures are distinguished from completed-without-evidence", () => {
  assert.equal(failedItem({ ...item, status: "failed" }), true);
  assert.equal(failedItem({ ...item, output: { FileNotFound: "missing" } }), true);
  assert.equal(failedItem({ ...item, output: { isError: true } }), true);
  // The observed Antigravity item loses its failure body. It provides no range evidence.
  assert.equal(failedItem({ ...item, output: null }), false);
  assert.deepEqual(readSpans(null, "text"), []);
});

test("unified patches are checked against the current document, including CRLF", () => {
  const diff = "@@ -1,2 +1,2 @@\n-old\n+new\n same\n";
  assert.deepEqual(patchSpans(diff, "new\nsame\n"), [[0, 0]]);
  assert.deepEqual(patchSpans(diff, "new\r\nsame\r\n"), [[0, 0]]);
  assert.deepEqual(patchSpans(diff, "human edit\nsame\n"), []);
  assert.deepEqual(patchSpans("operation failed", "text"), []);
  assert.deepEqual(patchSpans("@@ -1 +90 @@\n+x", "x"), []);
  assert.deepEqual(patchSpans("@@ -1 +0,0 @@\n-deleted", ""), []);
});

test("a multi-file item keeps its first-file diff separate from its other paths", () => {
  const decoded = traceItem({ ...item, type: "file_change", fileName: "a.ts", diffStr: "@@ -1 +1 @@\n-a\n+b", changes: [{ path: "a.ts" }, { path: "b.ts" }] })!;
  assert.equal(activityPath(decoded), "a.ts");
  assert.deepEqual(patchSpans(decoded.diffStr!, "b"), [[0, 0]]);
  assert.equal(decoded.changes?.length, 2);
});

test("partial and full Read ranges require matching returned content", () => {
  const text = "one\ntwo\nthree\n";
  assert.deepEqual(readSpans({ file: { content: "two\n", startLine: 2, numLines: 1 } }, text), [[1, 1]]);
  assert.deepEqual(readSpans({ file: { content: text, startLine: 1, numLines: 4 } }, text), [[0, 3]]);
  assert.deepEqual(readSpans({ file: { content: "old", startLine: 2, numLines: 1 } }, text), []);
  assert.deepEqual(readSpans({ file: { content: text, startLine: -1, numLines: 4 } }, text), []);
});

test("a provider patch relative to a replacement snippet is not painted at a wrong file line", () => {
  const fragment = "@@ -1,1 +1,1 @@\n-  return a + b + 1;\n\\ No newline at end of file\n+  return a + b + 2;\n\\ No newline at end of file\n";
  assert.deepEqual(patchSpans(fragment, "export function total(a, b) {\n  return a + b + 2;\n}\n"), []);
});

test("insights are short public text, not executable markdown or fabricated summaries", () => {
  assert.equal(publicInsight("Checking `routes.ts` before editing.\nMore detail"), "Checking routes.ts before editing.");
  assert.equal(publicInsight("# Final report"), undefined);
  assert.equal(publicInsight("```sh\nrm -rf"), undefined);
  assert.equal(publicInsight("x".repeat(1000))?.length, 160);
});
