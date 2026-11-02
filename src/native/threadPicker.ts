import * as vscode from "vscode";
import { isRunning, isSettled, needsAttention, sectionOf, type ThreadSection, type ThreadShell } from "../connection/shell";
import { relative, statusLabel } from "./threadInfo";

export type ThreadItem = vscode.QuickPickItem & { thread?: ThreadShell };

const OPEN_IN_TAB = "Open in New Tab (⌘T)";

export function isOpenInTab(button: vscode.QuickInputButton): boolean {
  return button.tooltip === OPEN_IN_TAB;
}

const SECTIONS: Array<{ section: ThreadSection; label: string; icon: string }> = [
  { section: "pinned", label: "Pinned", icon: "$(pinned)" },
  { section: "active", label: "Active", icon: "$(comment-discussion)" },
  { section: "snoozed", label: "Snoozed", icon: "$(bell-slash)" },
  { section: "settled", label: "Settled", icon: "$(pass)" },
];
const LIMIT = 400;

/**
 * The thread picker's rows: this window's threads in T3 Code's own sections, newest first, then the
 * other projects' threads. Each row says its state with an icon and words, and carries Settle (or
 * Unsettle) and Open in New Tab buttons.
 */
export function threadPickerItems(threads: ThreadShell[], scope: ReadonlySet<string> | undefined, projectTitle: (id: string) => string | undefined): ThreadItem[] {
  const sorted = [...threads].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const inScope = scope ? sorted.filter((thread) => scope.has(thread.projectId)) : sorted;
  const others = scope ? sorted.filter((thread) => !scope.has(thread.projectId)) : [];
  const items: ThreadItem[] = [];
  for (const { section, label } of SECTIONS) {
    const rows = inScope.filter((thread) => sectionOf(thread) === section);
    if (!rows.length) continue;
    items.push(separator(`${label} · ${rows.length}`), ...rows.slice(0, LIMIT).map((thread) => toItem(thread, projectTitle)));
  }
  if (others.length) items.push(separator(`Other projects · ${others.length}`), ...others.slice(0, LIMIT).map((thread) => toItem(thread, projectTitle)));
  return items;
}

function toItem(thread: ThreadShell, projectTitle: (id: string) => string | undefined): ThreadItem {
  const section = sectionOf(thread);
  const icon = isRunning(thread) ? "$(loading~spin)" : needsAttention(thread) ? "$(bell-dot)" : SECTIONS.find((entry) => entry.section === section)!.icon;
  const state = section === "settled" ? "Settled" : section === "snoozed" ? "Snoozed" : section === "pinned" ? "Pinned" : undefined;
  return {
    label: `${icon} ${thread.title || "Untitled thread"}`,
    description: [projectTitle(thread.projectId), thread.branch].filter(Boolean).join(" · "),
    detail: [state, statusLabel(thread), ago(thread.updatedAt)].filter(Boolean).join(" · "),
    thread,
    buttons: [
      isSettled(thread)
        ? { iconPath: new vscode.ThemeIcon("discard"), tooltip: "Unsettle (back to Active)" }
        : { iconPath: new vscode.ThemeIcon("check"), tooltip: "Settle" },
      { iconPath: new vscode.ThemeIcon("link-external"), tooltip: OPEN_IN_TAB },
    ],
  };
}

function ago(iso: string): string {
  const value = relative(iso);
  return value === "now" ? "just now" : `${value} ago`;
}

function separator(label: string): ThreadItem {
  return { label, kind: vscode.QuickPickItemKind.Separator };
}
