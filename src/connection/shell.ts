import * as vscode from "vscode";
import { isInside } from "../native/fileLinks";

/** The subset of T3 Code's `OrchestrationV2ThreadShell` that Threadside reads. Unknown fields pass through. */
export interface ThreadShell {
  id: string;
  projectId: string;
  title: string;
  status: string;
  branch: string | null;
  worktreePath: string | null;
  providerInstanceId?: string;
  modelSelection?: { model?: string };
  interactionMode?: string;
  lineage?: { parentThreadId: string | null; relationshipToParent: string | null; sideChat?: boolean };
  pullRequests?: Array<{ number?: number; url?: string; state?: string }>;
  pendingRuntimeRequest?: unknown;
  lastError?: string | null;
  usageLimitResetAt?: string | null;
  limitRecovery?: { resetAt?: string; autoResume?: boolean; snooze?: boolean } | null;
  settledAt?: string | null;
  settledOverride?: string | null;
  snoozedUntil?: string | null;
  pinnedAt?: string | null;
  pinOrderKey?: string | null;
  archivedAt?: string | null;
  deletedAt?: string | null;
  updatedAt: string;
  createdAt: string;
  latestUserMessageAt?: string | null;
  hasActionableProposedPlan?: boolean;
}

export interface ProjectShell {
  id: string;
  title: string;
  workspaceRoot: string;
  archivedAt?: string | null;
}

type ShellItem =
  | { kind: "synchronized" }
  | { kind: "snapshot"; snapshot: { threads: ThreadShell[]; projects: ProjectShell[] }; resolvedRepositoryIdentityRoots?: string[] }
  | { kind: "project.updated"; project: ProjectShell }
  | { kind: "project.removed"; projectId: string }
  | { kind: "thread.updated"; location: "active" | "archive"; thread: ThreadShell }
  | { kind: "thread.removed"; threadId: string }
  | { kind: string; [key: string]: unknown };

export type ThreadSection = "pinned" | "active" | "snoozed" | "settled";

/** Live mirror of the server's shell stream: every project and top-level thread. */
export class ShellStore {
  readonly threads = new Map<string, ThreadShell>();
  readonly projects = new Map<string, ProjectShell>();
  private readonly changed = new vscode.EventEmitter<ReadonlySet<string>>();
  /** Fires with the ids of threads that changed (empty set after a snapshot). */
  readonly onDidChange = this.changed.event;
  synchronized = false;

  apply(items: unknown[]): void {
    const touched = new Set<string>();
    let reset = false;
    for (const raw of items) {
      const item = raw as ShellItem;
      switch (item.kind) {
        case "snapshot": {
          const snapshot = (item as Extract<ShellItem, { kind: "snapshot" }>).snapshot;
          const roots = (item as { resolvedRepositoryIdentityRoots?: string[] }).resolvedRepositoryIdentityRoots;
          // A snapshot that names resolved roots patches those projects only.
          if (roots) {
            for (const project of snapshot.projects) this.projects.set(project.id, project);
            break;
          }
          this.threads.clear();
          this.projects.clear();
          for (const project of snapshot.projects) this.projects.set(project.id, project);
          for (const thread of snapshot.threads) if (isListed(thread)) this.threads.set(thread.id, thread);
          reset = true;
          break;
        }
        case "synchronized":
          this.synchronized = true;
          break;
        case "project.updated": {
          const project = (item as { project: ProjectShell }).project;
          this.projects.set(project.id, project);
          reset = true;
          break;
        }
        case "project.removed":
          this.projects.delete((item as { projectId: string }).projectId);
          reset = true;
          break;
        case "thread.updated": {
          const { thread, location } = item as { thread: ThreadShell; location: string };
          if (location === "active" && isListed(thread)) this.threads.set(thread.id, thread);
          else this.threads.delete(thread.id);
          touched.add(thread.id);
          break;
        }
        case "thread.removed": {
          const id = (item as { threadId: string }).threadId;
          this.threads.delete(id);
          touched.add(id);
          break;
        }
        default:
          break;
      }
    }
    this.changed.fire(reset ? new Set() : touched);
  }

  clear(): void {
    this.threads.clear();
    this.projects.clear();
    this.synchronized = false;
    this.changed.fire(new Set());
  }

  /** The project of `path`: a thread worktree that contains it, else the deepest project root. */
  projectForPath(path: string): ProjectShell | undefined {
    for (const thread of this.threads.values()) {
      if (thread.worktreePath && isInside(thread.worktreePath, path)) {
        const project = this.projects.get(thread.projectId);
        if (project) return project;
      }
    }
    return this.projectForRoot(path);
  }

  private projectForRoot(path: string): ProjectShell | undefined {
    let best: ProjectShell | undefined;
    for (const project of this.projects.values()) {
      if (project.archivedAt || !isInside(project.workspaceRoot, path)) continue;
      if (!best || project.workspaceRoot.length > best.workspaceRoot.length) best = project;
    }
    return best;
  }

  dispose(): void {
    this.changed.dispose();
  }
}

/** Subagent children and side chats (forks marked `sideChat`) live under their parent, not in the list. */
function isListed(thread: ThreadShell): boolean {
  if (thread.archivedAt || thread.deletedAt || thread.lineage?.sideChat) return false;
  const relationship = thread.lineage?.relationshipToParent ?? null;
  return relationship === null || relationship === "fork";
}

export function sectionOf(thread: ThreadShell, now = Date.now()): ThreadSection {
  if (isSettled(thread)) return "settled";
  if (thread.snoozedUntil && Date.parse(thread.snoozedUntil) > now && !needsAttention(thread)) return "snoozed";
  if (thread.pinnedAt) return "pinned";
  return "active";
}

export function isSettled(thread: ThreadShell): boolean {
  if (thread.settledOverride === "settled") return true;
  if (thread.settledOverride === "unsettled") return false;
  return Boolean(thread.settledAt);
}

export function isRunning(thread: ThreadShell): boolean {
  return thread.status === "running" || thread.status === "starting";
}

export function needsAttention(thread: ThreadShell): boolean {
  return Boolean(thread.pendingRuntimeRequest) || thread.hasActionableProposedPlan === true;
}

export function limitResetAt(thread: ThreadShell): Date | undefined {
  const value = thread.limitRecovery?.resetAt ?? thread.usageLimitResetAt;
  if (!value) return undefined;
  const date = new Date(value);
  return date.getTime() > Date.now() ? date : undefined;
}
