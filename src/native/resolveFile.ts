import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, relative } from "node:path";
import * as vscode from "vscode";
import { log, redact } from "../log";
import { type FileTarget, isInside, parseFileHref } from "./fileLinks";

const EXCLUDE = "**/{node_modules,.git,dist,build,.next,.venv,venv,__pycache__,.mypy_cache,.pytest_cache,coverage}/**";

/**
 * Finds the file a chat link means. Agents often write a bare or partial path (`observability.py`,
 * `llm/observability.py:42`) that T3 Code resolves by searching the project, so a link is tried
 * against each base (thread checkout, project root, workspace folders) and then searched by its path
 * suffix under those bases. Several matches ask which one; the closest to the thread comes first.
 */
export async function resolveFileLink(href: string, bases: string[], toUri: (path: string) => vscode.Uri): Promise<FileTarget | undefined> {
  const roots = [...new Set(bases.filter(Boolean))];
  const first = parseFileHref(href, roots[0], homedir());
  if (!first) {
    log().info(`Not a file link: ${redact(href)}`);
    return undefined;
  }
  for (const root of roots) {
    const target = parseFileHref(href, root, homedir());
    if (target && existsSync(target.path)) return target;
  }

  // Search by the path as the agent wrote it (without its line suffix); an absolute path that does
  // not exist here is searched by its file name.
  // T3 Code often sends a path it already joined to the project root; the part below whichever base
  // contains it is what the agent wrote, and is a far more precise search than the file name.
  const absolute = /^(\/|~|file:|[A-Za-z]:[\\/])/.test(href.trim());
  const written = parseFileHref(href, "/", homedir());
  const containing = absolute
    ? roots.filter((root) => isInside(root, first.path) && root !== first.path).sort((a, b) => b.length - a.length)[0]
    : undefined;
  const suffix = containing
    ? relative(containing, first.path).replace(/\\/g, "/")
    : !absolute && written
      ? relative("/", written.path).replace(/\\/g, "/")
      : basename(first.path);
  // The written path first; if nothing has it, the file name alone.
  let matches = await search(suffix, roots, toUri);
  const name = basename(first.path);
  if (!matches.size && suffix !== name) matches = await search(name, roots, toUri);
  log().info(`File link ${redact(href)}: ${matches.size} match(es) for **/${matches.size ? suffix : name}.`);
  const paths = [...matches.keys()].sort((a, b) => a.length - b.length);
  if (!paths.length) {
    void vscode.window.showWarningMessage(`Could not find ${suffix} in this thread's checkout or the workspace. Alt-click the link to preview it in T3 Code.`);
    return undefined;
  }
  let chosen = paths[0];
  if (paths.length > 1) {
    const root = roots[0];
    const pick = await vscode.window.showQuickPick(
      paths.map((path) => ({ label: basename(path), description: root ? relative(root, path) : path, path })),
      { title: `Open ${suffix}`, placeHolder: `${paths.length} files match` },
    );
    if (!pick) return undefined;
    chosen = pick.path;
  }
  return { ...first, path: chosen! };
}

async function search(suffix: string, roots: string[], toUri: (path: string) => vscode.Uri): Promise<Map<string, vscode.Uri>> {
  const matches = new Map<string, vscode.Uri>();
  for (const root of roots) {
    const found = await vscode.workspace.findFiles(new vscode.RelativePattern(toUri(root), `**/${suffix}`), EXCLUDE, 50);
    for (const uri of found) matches.set(uri.fsPath, uri);
    if (matches.size) return matches;
  }
  for (const uri of await vscode.workspace.findFiles(`**/${suffix}`, EXCLUDE, 50)) matches.set(uri.fsPath, uri);
  return matches;
}
