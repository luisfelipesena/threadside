import assert from "node:assert/strict";
import { test } from "node:test";
import { compareVersions, newerRelease, type Release } from "../src/connection/updates.ts";

const release = (tag_name: string, prerelease = tag_name.includes("-nightly.")): Release => ({ tag_name, prerelease, draft: false });
const releases = [
  release("v0.1.7-nightly.20261102.4093"),
  release("v0.1.7-nightly.20261102.4080"),
  release("v0.1.7-nightly.20261101.4048"),
  { ...release("v0.1.8-nightly.20261103.5000"), draft: true },
  release("v0.1.6"),
  release("v0.1.5"),
];

test("a nightly server is offered the newest nightly, never a draft", () => {
  assert.equal(newerRelease("0.1.7-nightly.20261102.4080", releases), "0.1.7-nightly.20261102.4093");
  assert.equal(newerRelease("0.1.7-nightly.20261102.4093", releases), undefined);
});

test("a stable server is offered stable releases only", () => {
  assert.equal(newerRelease("0.1.5", releases), "0.1.6");
  assert.equal(newerRelease("0.1.6", releases), undefined);
});

test("versions order by number, then nightly date and build, with a nightly before its release", () => {
  assert.equal(compareVersions("0.1.10", "0.1.9"), 1);
  assert.equal(compareVersions("0.1.7-nightly.20261102.4093", "0.1.7-nightly.20261102.4080"), 1);
  assert.equal(compareVersions("0.1.7-nightly.20261102.4093", "0.1.7"), -1);
  assert.equal(newerRelease("dev", releases), undefined);
});
