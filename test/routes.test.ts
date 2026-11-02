import assert from "node:assert/strict";
import { test } from "node:test";
import { threadIdFromPath, threadPath } from "../src/routes.ts";

const env = "ad9a2707-858c-4eca-906f-b45644605807";

test("plain and prefixed thread ids round-trip through routes", () => {
  for (const id of ["9fc933a8-98e5-41f2-9cf4-830a61190aeb", "mcp:5d189947-ba0c-4262-96bb-9834cc90671c"]) {
    assert.equal(threadIdFromPath(threadPath(env, id)), id);
  }
  assert.equal(threadIdFromPath(`${threadPath(env, "mcp:x")}?prompt=hi`), "mcp:x");
});

test("non-thread routes have no thread id", () => {
  assert.equal(threadIdFromPath("/settings/general"), undefined);
  assert.equal(threadIdFromPath(`/draft/${env}`), undefined);
  assert.equal(threadIdFromPath("/"), undefined);
});
