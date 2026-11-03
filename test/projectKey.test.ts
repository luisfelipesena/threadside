import assert from "node:assert/strict";
import { test } from "node:test";
import { notificationTag, sidebarProjectKey } from "../src/connection/projectKey.ts";

const env = "6c8a3f2e-0000-4000-8000-000000000001";

test("a repository project is filtered by its canonical key, preferring the origin's", () => {
  const identity = { canonicalKey: "github.com/me/app" };
  assert.equal(sidebarProjectKey({ workspaceRoot: "/code/app", repositoryIdentity: identity }, env), "github.com/me/app");
  const fork = { canonicalKey: "github.com/me/app", origin: { canonicalKey: "github.com/org/app" } };
  assert.equal(sidebarProjectKey({ workspaceRoot: "/code/app", repositoryIdentity: fork }, env), "github.com/org/app");
});

test("a folder without a repository is filtered by environment and path", () => {
  assert.equal(sidebarProjectKey({ workspaceRoot: "/Users/me/Development/Work/", repositoryIdentity: null }, env), `${env}:/Users/me/Development/Work`);
  assert.equal(sidebarProjectKey({ workspaceRoot: "C:/Code/App" }, env), `${env}:c:\\code\\app`);
});

test("a notification tag matches T3 Code's hash of environment and thread", () => {
  // Reference values computed with T3 Code's own `BT` function from its web bundle.
  assert.equal(notificationTag("env-1", "thread-1"), "987fa5ec10182b3e");
  assert.equal(notificationTag("ad9a2707-858c-4eca-906f-b45644605807", "88a2098f-7ecc-403a-9bcb-99c94352e4cb"), "e12fbff53c73056b");
});
