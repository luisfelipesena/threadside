import { execFile } from "node:child_process";
import { join } from "node:path";
import * as vscode from "vscode";

interface GitApi {
  toGitUri(uri: vscode.Uri, ref: string): vscode.Uri;
}

function gitApi(): GitApi | undefined {
  const extension = vscode.extensions.getExtension<{ getAPI(version: 1): GitApi }>("vscode.git");
  if (!extension?.isActive) return undefined;
  return extension.exports.getAPI(1);
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, maxBuffer: 32 << 20, timeout: 20_000 }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    );
  });
}

async function baseRef(cwd: string): Promise<string | undefined> {
  const candidates: string[] = [];
  const upstreamHead = await git(cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]).catch(() => "");
  if (upstreamHead.trim()) candidates.push(upstreamHead.trim());
  candidates.push("origin/main", "origin/master", "origin/dev", "main", "master");
  for (const candidate of candidates) {
    const base = await git(cwd, ["merge-base", "HEAD", candidate]).catch(() => "");
    if (base.trim()) return base.trim();
  }
  return undefined;
}

type Change = { status: string; path: string; oldPath?: string };

function parseNameStatus(output: string): Change[] {
  const fields = output.split("\0").filter(Boolean);
  const changes: Change[] = [];
  for (let i = 0; i < fields.length; ) {
    const status = fields[i++]!;
    if (status.startsWith("R") || status.startsWith("C")) {
      const oldPath = fields[i++]!;
      changes.push({ status: status[0]!, oldPath, path: fields[i++]! });
    } else {
      changes.push({ status: status[0]!, path: fields[i++]! });
    }
  }
  return changes;
}

/**
 * Opens a thread's changes in the editor's multi-file diff: uncommitted work against HEAD, or the
 * whole branch against its merge base. Paths come from git, so renames and deletions show correctly.
 */
export async function reviewChanges(cwd: string, title: string, workspaceUri: (path: string) => vscode.Uri): Promise<void> {
  const api = gitApi();
  if (!api) {
    void vscode.window.showWarningMessage("Review needs the built-in Git extension. Enable it and try again.");
    return;
  }
  const isRepo = await git(cwd, ["rev-parse", "--is-inside-work-tree"]).catch(() => "");
  if (isRepo.trim() !== "true") {
    void vscode.window.showInformationMessage(`${cwd} is not a git checkout, so there is nothing to review.`);
    return;
  }
  const uncommitted = parseNameStatus(await git(cwd, ["diff", "--name-status", "-z", "HEAD"]));
  const untracked = (await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]))
    .split("\0")
    .filter(Boolean)
    .map((path): Change => ({ status: "A", path }));
  const base = await baseRef(cwd);
  const branch = base ? parseNameStatus(await git(cwd, ["diff", "--name-status", "-z", base])) : [];
  const branchFiles = [...branch, ...untracked.filter((change) => !branch.some((other) => other.path === change.path))];

  type Pick = vscode.QuickPickItem & { ref: string; changes: Change[] };
  const picks: Pick[] = [];
  const working = [...uncommitted, ...untracked];
  if (working.length) picks.push({ label: "$(edit) Uncommitted changes", description: `${working.length} files vs HEAD`, ref: "HEAD", changes: working });
  if (base && branchFiles.length) {
    picks.push({ label: "$(git-branch) Whole branch", description: `${branchFiles.length} files vs merge base ${base.slice(0, 8)}`, ref: base, changes: branchFiles });
  }
  if (!picks.length) {
    void vscode.window.showInformationMessage("This thread has no changes yet.");
    return;
  }
  const choice = picks.length === 1 ? picks[0] : await vscode.window.showQuickPick(picks, { title: `Review ${title}` });
  if (!choice) return;
  const resources = choice.changes.map((change) => {
    const modified = workspaceUri(join(cwd, change.path));
    const original = api.toGitUri(workspaceUri(join(cwd, change.oldPath ?? change.path)), choice.ref);
    return [
      modified,
      change.status === "A" ? undefined : original,
      change.status === "D" ? undefined : modified,
    ] as const;
  });
  await vscode.commands.executeCommand("vscode.changes", `${title} (${choice.label.replace(/^\$\([^)]+\)\s*/, "")})`, resources);
}
