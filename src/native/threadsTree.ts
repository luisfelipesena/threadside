import * as vscode from "vscode";
import type { Environment } from "../connection/environment";
import {
  isRunning,
  limitResetAt,
  needsAttention,
  sectionOf,
  type ThreadSection,
  type ThreadShell,
} from "../connection/shell";

const SECTIONS: Array<{ id: ThreadSection; label: string }> = [
  { id: "pinned", label: "Pinned" },
  { id: "active", label: "Active" },
  { id: "snoozed", label: "Snoozed" },
  { id: "settled", label: "Settled" },
];

type Node = { kind: "section"; section: ThreadSection; count: number } | { kind: "thread"; thread: ThreadShell };

/** The T3 thread list in the activity bar, live from the shell stream. */
export class ThreadsTree implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly subscriptions: vscode.Disposable[] = [];
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private tickTimer: ReturnType<typeof setInterval>;

  constructor(
    private readonly environment: Environment,
    private readonly scopeProjects: () => ReadonlySet<string> | undefined,
  ) {
    this.subscriptions.push(environment.shell.onDidChange(() => this.refreshSoon()));
    // Relative times and snooze wake-ups change without server events.
    this.tickTimer = setInterval(() => this.changed.fire(undefined), 60_000);
  }

  refresh(): void {
    this.changed.fire(undefined);
  }

  private refreshSoon(): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.changed.fire(undefined), 150);
  }

  threadsInScope(): ThreadShell[] {
    const scope = this.scopeProjects();
    return [...this.environment.shell.threads.values()].filter((thread) => !scope || scope.has(thread.projectId));
  }

  getChildren(node?: Node): Node[] {
    if (this.environment.status.kind !== "connected") return [];
    const threads = this.threadsInScope();
    if (!node) {
      const counts = new Map<ThreadSection, number>();
      for (const thread of threads) counts.set(sectionOf(thread), (counts.get(sectionOf(thread)) ?? 0) + 1);
      return SECTIONS.filter((section) => (counts.get(section.id) ?? 0) > 0).map((section) => ({
        kind: "section",
        section: section.id,
        count: counts.get(section.id) ?? 0,
      }));
    }
    if (node.kind !== "section") return [];
    const limit = vscode.workspace.getConfiguration("threadside").get("settledLimit", 25);
    const items = threads
      .filter((thread) => sectionOf(thread) === node.section)
      .sort((a, b) => sortKey(b, node.section) - sortKey(a, node.section));
    return (node.section === "settled" ? items.slice(0, limit) : items).map((thread) => ({ kind: "thread", thread }));
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === "section") {
      const label = SECTIONS.find((section) => section.id === node.section)!.label;
      const item = new vscode.TreeItem(
        label,
        node.section === "settled" || node.section === "snoozed"
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.Expanded,
      );
      item.id = `section:${node.section}`;
      item.description = String(node.count);
      item.contextValue = `section:${node.section}`;
      return item;
    }
    const { thread } = node;
    const section = sectionOf(thread);
    const item = new vscode.TreeItem(thread.title || "Untitled thread", vscode.TreeItemCollapsibleState.None);
    item.id = `thread:${thread.id}`;
    item.iconPath = iconFor(thread);
    item.description = describe(thread, this.environment.shell.projects.get(thread.projectId)?.title, !this.scopeProjects());
    item.tooltip = tooltipFor(thread, this.environment.shell.projects.get(thread.projectId)?.title);
    const flags = [isRunning(thread) ? "+running" : "", thread.worktreePath ? "+worktree" : ""].join("");
    item.contextValue = `thread:${section}${flags}`;
    item.command = { command: "threadside.openThread", title: "Open Thread", arguments: [thread.id] };
    return item;
  }

  getParent(): undefined {
    return undefined;
  }

  dispose(): void {
    clearTimeout(this.refreshTimer);
    clearInterval(this.tickTimer);
    for (const subscription of this.subscriptions) subscription.dispose();
    this.changed.dispose();
  }
}

function sortKey(thread: ThreadShell, section: ThreadSection): number {
  if (section === "settled") return Date.parse(thread.settledAt ?? thread.updatedAt);
  if (section === "snoozed") return -Date.parse(thread.snoozedUntil ?? thread.updatedAt);
  return Date.parse(thread.updatedAt);
}

export function iconFor(thread: ThreadShell): vscode.ThemeIcon {
  if (needsAttention(thread) && thread.pendingRuntimeRequest) {
    return new vscode.ThemeIcon("bell-dot", new vscode.ThemeColor("notificationsWarningIcon.foreground"));
  }
  if (isRunning(thread)) return new vscode.ThemeIcon("loading~spin");
  if (limitResetAt(thread)) return new vscode.ThemeIcon("watch", new vscode.ThemeColor("notificationsWarningIcon.foreground"));
  if (thread.status === "failed") return new vscode.ThemeIcon("error", new vscode.ThemeColor("errorForeground"));
  if (thread.status === "interrupted" || thread.status === "cancelled") return new vscode.ThemeIcon("debug-pause");
  if (thread.hasActionableProposedPlan) return new vscode.ThemeIcon("checklist");
  if (thread.lineage?.relationshipToParent === "fork") return new vscode.ThemeIcon("repo-forked");
  if (thread.worktreePath) return new vscode.ThemeIcon("git-branch");
  return new vscode.ThemeIcon("comment-discussion");
}

function describe(thread: ThreadShell, project: string | undefined, showProject: boolean): string {
  const parts: string[] = [];
  const reset = limitResetAt(thread);
  if (reset) parts.push(`resumes ${clock(reset)}`);
  else if (sectionOf(thread) === "snoozed" && thread.snoozedUntil) parts.push(`until ${clock(new Date(thread.snoozedUntil))}`);
  else parts.push(relative(thread.updatedAt));
  if (showProject && project) parts.push(project);
  if (thread.branch) parts.push(thread.branch);
  return parts.join(" · ");
}

export function tooltipFor(thread: ThreadShell, project: string | undefined): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.appendMarkdown(`**${escapeMd(thread.title || "Untitled thread")}**\n\n`);
  const rows: string[] = [];
  rows.push(`$(circle-filled) ${statusLabel(thread)}`);
  if (project) rows.push(`$(folder) ${escapeMd(project)}`);
  if (thread.modelSelection?.model) rows.push(`$(sparkle) ${escapeMd(thread.modelSelection.model)}`);
  if (thread.branch) rows.push(`$(git-branch) ${escapeMd(thread.branch)}`);
  if (thread.worktreePath) rows.push(`$(folder-library) ${escapeMd(thread.worktreePath)}`);
  for (const pr of thread.pullRequests ?? []) if (pr.url) rows.push(`$(git-pull-request) [#${pr.number ?? ""}](${pr.url})`);
  if (thread.lastError) rows.push(`$(error) ${escapeMd(thread.lastError.slice(0, 200))}`);
  md.appendMarkdown(rows.join("  \n"));
  md.appendMarkdown(`\n\n_Updated ${relative(thread.updatedAt)} ago_`);
  return md;
}

export function statusLabel(thread: ThreadShell): string {
  if (thread.pendingRuntimeRequest) return "Waiting for you";
  const reset = limitResetAt(thread);
  if (reset) return thread.limitRecovery?.autoResume ? `Usage limit, resumes at ${clock(reset)}` : `Usage limit until ${clock(reset)}`;
  if (isRunning(thread)) return "Working";
  const labels: Record<string, string> = {
    idle: "Ready",
    completed: "Done",
    failed: "Failed",
    interrupted: "Interrupted",
    cancelled: "Stopped",
  };
  return labels[thread.status] ?? thread.status;
}

export function relative(iso: string): string {
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 86_400 * 30) return `${Math.floor(seconds / 86_400)}d`;
  return `${Math.floor(seconds / (86_400 * 30))}mo`;
}

function clock(date: Date): string {
  const sameDay = date.toDateString() === new Date().toDateString();
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return sameDay ? time : `${date.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
}

function escapeMd(value: string): string {
  return value.replace(/([\\`*_{}[\]()#+\-.!|<>])/g, "\\$1");
}
