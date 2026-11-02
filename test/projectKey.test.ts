import assert from "node:assert/strict";
import { test } from "node:test";
import { sidebarProjectKey } from "../src/connection/projectKey.ts";

const env = "6c8a3f2e-0000-4000-8000-000000000001";

test("a repository project is filtered by its canonical key, preferring the origin's", () => {
  const identity = { canonicalKey: "github.com/me/app" };
  assert.equal(sidebarProjectKey({ workspaceRoot: "/code/app", repositoryIdentity: identity }, env), "github.com/me/app");
  const fork = { canonicalKey: "github.com/me/app", origin: { canonicalKey: "github.com/org/app" } };
  assert.equal(sidebarProjectKey({ workspaceRoot: "/code/app", repositoryIdentity: fork }, env), "github.com/org/app");
});

test("a folder without a repository is filtered by environment and path", () => {
  assert.equal(sidebarProjectKey({ workspaceRoot: "/Users/me/Development/MetaCto/", repositoryIdentity: null }, env), `${env}:/Users/me/Development/MetaCto`);
  assert.equal(sidebarProjectKey({ workspaceRoot: "C:/Code/App" }, env), `${env}:c:\\code\\app`);
});
