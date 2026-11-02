import assert from "node:assert/strict";
import { test } from "node:test";
import { mentionFor, parseFileHref } from "../src/native/fileLinks.ts";

const base = "/work/repo";
const home = "/Users/me";

test("relative path with line and column", () => {
  assert.deepEqual(parseFileHref("src/a.ts:12:5", base, home), { path: "/work/repo/src/a.ts", line: 12, column: 5, endLine: undefined });
});

test("GitHub-style line range", () => {
  assert.deepEqual(parseFileHref("src/a.ts#L10-L20", base, home), { path: "/work/repo/src/a.ts", line: 10, column: undefined, endLine: 20 });
});

test("line with column hash", () => {
  assert.equal(parseFileHref("src/a.ts#L7C3", base, home)?.column, 3);
});

test("absolute path and colon range", () => {
  assert.deepEqual(parseFileHref("/etc/x.conf:3-9", base, home), { path: "/etc/x.conf", line: 3, column: undefined, endLine: 9 });
});

test("file URL with encoded spaces", () => {
  assert.deepEqual(parseFileHref("file:///work/my%20repo/a.py#L4", base, home), { path: "/work/my repo/a.py", line: 4, column: undefined, endLine: undefined });
});

test("home-relative path", () => {
  assert.equal(parseFileHref("~/notes.md", base, home)?.path, "/Users/me/notes.md");
});

test("web URLs and relative paths without a base are not files", () => {
  assert.equal(parseFileHref("https://example.com/a.ts", base, home), undefined);
  assert.equal(parseFileHref("src/a.ts", undefined, home), undefined);
});

test("dot segments are normalized", () => {
  assert.equal(parseFileHref("./src/../lib/b.ts", base, home)?.path, "/work/repo/lib/b.ts");
});

test("mentions use the composer's markdown chip form", () => {
  assert.equal(mentionFor("src/a.ts"), "[a.ts](src/a.ts)");
  assert.equal(mentionFor("src/a.ts", 3, 9), "[a.ts:3-9](src/a.ts:3-9)");
  assert.equal(mentionFor("src/a.ts", 3, 3), "[a.ts:3](src/a.ts:3)");
  assert.equal(mentionFor("my dir/a b.ts"), "[a b.ts](my%20dir/a%20b.ts)");
  assert.equal(mentionFor("x/[id].tsx"), "[\\[id\\].tsx](x/[id].tsx)");
});
