import * as vscode from "vscode";
import { BEGIN, renderBlock, uiPlatformOf, withBlock, withoutBlock } from "./block";

const BACKUP_KEY = "threadside.keybindingsBackup";
let wasOpen = false;

/** Saves the edit and closes the file again unless the user already had it open. */
async function saveAndClose(editor: vscode.TextEditor): Promise<void> {
  await editor.document.save();
  if (wasOpen) return;
  const tabs = vscode.window.tabGroups.all.flatMap((group) =>
    group.tabs.filter((tab) => tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === editor.document.uri.toString()),
  );
  await vscode.window.tabGroups.close(tabs);
}

/** Opens the user's keybindings.json (on the machine with the screen, even in a remote window). */
async function openKeybindings(): Promise<vscode.TextEditor> {
  wasOpen = vscode.window.tabGroups.all.some((group) =>
    group.tabs.some((tab) => tab.input instanceof vscode.TabInputText && /\/keybindings\.json$/.test(tab.input.uri.path)),
  );
  await vscode.commands.executeCommand("workbench.action.openGlobalKeybindingsFile");
  for (let attempt = 0; attempt < 40; attempt++) {
    const editor = [vscode.window.activeTextEditor, ...vscode.window.visibleTextEditors].find(
      (candidate) => candidate && /\/keybindings\.json$/.test(candidate.document.uri.path),
    );
    if (editor) return editor;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Could not open keybindings.json.");
}

/** Adds the managed block at the end of keybindings.json, keeping comments and the user's own rules. */
export async function takeOverShortcuts(state: vscode.Memento): Promise<void> {
  const editor = await openKeybindings();
  const original = editor.document.getText();
  if (!original.includes(BEGIN)) await state.update(BACKUP_KEY, original);
  await replaceAll(editor, withBlock(original, renderBlock(uiPlatformOf(editor.document.uri.path))));
  await saveAndClose(editor);
  void vscode.window.showInformationMessage(
    "T3 now owns Cursor's chat shortcuts: ⌘I opens or hides the chat, ⌘L adds the selection, ⇧⌘H searches threads, ⌘' starts a thread, ⌥⌘E full screen. 'T3: Restore Cursor Chat Shortcuts' puts yours back.",
  );
}

export async function restoreShortcuts(state: vscode.Memento): Promise<void> {
  const editor = await openKeybindings();
  const current = editor.document.getText();
  const backup = state.get<string>(BACKUP_KEY);
  const next = withoutBlock(current);
  await replaceAll(editor, backup !== undefined && withoutBlock(backup) === next ? backup : next);
  await saveAndClose(editor);
  await state.update(BACKUP_KEY, undefined);
  void vscode.window.showInformationMessage("Cursor's chat shortcuts are back.");
}

async function replaceAll(editor: vscode.TextEditor, text: string): Promise<void> {
  const document = editor.document;
  const range = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
  await editor.edit((edit) => edit.replace(range, text));
}
