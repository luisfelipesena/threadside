import * as vscode from "vscode";

/**
 * Keeps the chat column like Cursor's chat pane: its editor group is locked, so files you open (from
 * the Explorer, Quick Open or a link in the chat) and files dropped on the chat open in the code
 * column instead of splitting the chat. The editor saves the lock with the layout.
 */
export async function lockChatGroup(isChatTab: (tab: vscode.Tab) => boolean): Promise<void> {
  const group = vscode.window.tabGroups.activeTabGroup;
  if (!group.tabs.length || !group.tabs.every(isChatTab)) return;
  await vscode.commands.executeCommand("workbench.action.lockEditorGroup");
}
