import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { traceCheckout, sameCheckout } from "../src/native/traceCheckout.ts";

test("nested projects resolve their own repository and symbolic HEAD tolerates commits", async () => {
  const root = await mkdtemp(join(tmpdir(), "threadside-branch-"));
  try {
    await mkdir(join(root, ".git"));
    await writeFile(join(root, ".git/HEAD"), "ref: refs/heads/main\n");
    await mkdir(join(root, "app/src"), { recursive: true });
    await writeFile(join(root, "app/src/index.ts"), "code");
    const original = await traceCheckout(join(root, "app/src/index.ts"));
    assert.equal(original?.branch, "main");
    assert.equal(sameCheckout(original, await traceCheckout(root)), true);
    await writeFile(join(root, ".git/HEAD"), "ref: refs/heads/feature\n");
    assert.equal(sameCheckout(original, await traceCheckout(root)), false);
    await mkdir(join(root, "app/.git"));
    await writeFile(join(root, "app/.git/HEAD"), "ref: refs/heads/nested\n");
    assert.equal((await traceCheckout(join(root, "app/src/index.ts")))?.branch, "nested");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("worktrees read their gitdir HEAD, and detached checkouts include the commit identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "threadside-worktree-"));
  try {
    await mkdir(join(root, "metadata/worktrees/one"), { recursive: true });
    await mkdir(join(root, "checkout"));
    await writeFile(join(root, "checkout/.git"), "gitdir: ../metadata/worktrees/one\n");
    await writeFile(join(root, "metadata/worktrees/one/HEAD"), "a".repeat(40) + "\n");
    const detached = await traceCheckout(join(root, "checkout"));
    assert.equal(detached?.branch, "Detached aaaaaaaa");
    await writeFile(join(root, "metadata/worktrees/one/HEAD"), "b".repeat(40) + "\n");
    assert.equal(sameCheckout(detached, await traceCheckout(join(root, "checkout"))), false);
    assert.equal(await traceCheckout(join(root, "missing")), undefined);
    assert.equal(sameCheckout(undefined, undefined), true);
    assert.equal(sameCheckout(detached, undefined), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
