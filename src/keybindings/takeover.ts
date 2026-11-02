import * as vscode from "vscode";

const BEGIN = "// threadside:begin (managed by the T3 Threadside extension; run 'T3: Restore Cursor Chat Shortcuts' to remove)";
const END = "// threadside:end";
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

/**
 * Cursor's chat shortcuts, moved to T3. The block sits at the end of keybindings.json, and the last
 * matching rule wins, so no Cursor binding has to be removed: undoing the takeover is deleting the block.
 */
export const TAKEOVER_RULES: Array<{ key: string; command: string; when?: string }> = [
  { key: "cmd+i", command: "threadside.toggleChat" },
  { key: "cmd+l", command: "threadside.focusOrAddSelection" },
  { key: "shift+cmd+l", command: "threadside.addSelection", when: "editorTextFocus && editorHasSelection" },
  { key: "shift+cmd+h", command: "threadside.searchThreads" },
  { key: "cmd+'", command: "threadside.newThread" },
  { key: "alt+cmd+e", command: "threadside.toggleMaximize" },
  { key: "alt+cmd+r", command: "threadside.reviewChanges", when: "threadside.activeHasWorktree" },
];

/**
 * keybindings.json belongs to the machine with the screen, which in a Remote-SSH window is not the one
 * running this extension, so the platform comes from the file's own path.
 */
export function uiPlatformOf(keybindingsPath: string): "mac" | "other" {
  return /\/Library\/Application Support\//.test(keybindingsPath) ? "mac" : "other";
}

function block(platform: "mac" | "other"): string {
  const mod = (key: string) => (platform === "mac" ? key : key.replace(/cmd/g, "ctrl"));
  const lines = TAKEOVER_RULES.map((rule) => `  ${JSON.stringify({ ...rule, key: mod(rule.key) })},`);
  return [`  ${BEGIN}`, ...lines, `  ${END}`].join("\n");
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

function withoutBlock(text: string): string {
  const start = text.indexOf(BEGIN);
  if (start < 0) return text;
  const lineStart = text.lastIndexOf("\n", start) + 1;
  const end = text.indexOf(END, start);
  const lineEnd = end < 0 ? text.length : text.indexOf("\n", end) + 1 || text.length;
  return text.slice(0, lineStart) + text.slice(lineEnd);
}

/** Inserts the managed block before the closing bracket, keeping comments and the user's own rules. */
export async function takeOverShortcuts(state: vscode.Memento): Promise<void> {
  const editor = await openKeybindings();
  const original = editor.document.getText();
  if (!original.includes(BEGIN)) await state.update(BACKUP_KEY, original);
  const text = withoutBlock(original);
  const close = text.lastIndexOf("]");
  if (close < 0) throw new Error("keybindings.json has no closing bracket.");
  const before = text.slice(0, close).replace(/\s*$/, "");
  const needsComma = !/[[,]$/.test(before.replace(/\/\/[^\n]*$/gm, "").trimEnd());
  const next = `${before}${needsComma ? "," : ""}\n${block(uiPlatformOf(editor.document.uri.path))}\n${text.slice(close)}`;
  await replaceAll(editor, next);
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
