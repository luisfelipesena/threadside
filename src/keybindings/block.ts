import { createScanner, parseTree, SyntaxKind } from "jsonc-parser";

export const BEGIN = "// threadside:begin (managed by the T3 Threadside extension; run 'T3: Restore Cursor Chat Shortcuts' to remove)";
export const END = "// threadside:end";
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
  // In the thread search, ahead of any ⌘T the user bound elsewhere.
  { key: "cmd+t", command: "threadside.openPickedThreadInTab", when: "threadside.threadPickerOpen" },
];

/**
 * keybindings.json belongs to the machine with the screen, which in a Remote-SSH window is not the one
 * running this extension, so the platform comes from the file's own path.
 */
export function uiPlatformOf(keybindingsPath: string): "mac" | "other" {
  return /\/Library\/Application Support\//.test(keybindingsPath) ? "mac" : "other";
}

export function renderBlock(platform: "mac" | "other"): string {
  const mod = (key: string) => (platform === "mac" ? key : key.replace(/cmd/g, "ctrl"));
  const lines = TAKEOVER_RULES.map((rule) => `  ${JSON.stringify({ ...rule, key: mod(rule.key) })},`);
  return [`  ${BEGIN}`, ...lines, `  ${END}`].join("\n");
}

export function withoutBlock(text: string): string {
  const start = text.indexOf(BEGIN);
  if (start < 0) return text;
  const end = text.indexOf(END, start);
  if (end < 0) throw new Error("keybindings.json has a Threadside block without its end marker; fix it by hand first.");
  const lineStart = text.lastIndexOf("\n", start) + 1;
  const lineEnd = text.indexOf("\n", end) + 1 || text.length;
  return text.slice(0, lineStart) + text.slice(lineEnd);
}

/** Inserts the block as the last entries of the root array, using a JSONC parse rather than text search. */
export function withBlock(text: string, block: string): string {
  const base = withoutBlock(text).trim() ? withoutBlock(text) : "[\n]\n";
  const root = parseTree(base);
  if (!root || root.type !== "array") throw new Error("keybindings.json is not a JSON array.");
  const close = root.offset + root.length - 1;
  const last = root.children?.at(-1);
  if (!last) return `${base.slice(0, root.offset + 1)}\n${block}\n${base.slice(close)}`;
  const lastEnd = last.offset + last.length;
  const scanner = createScanner(base.slice(lastEnd, close), false);
  let hasComma = false;
  for (let kind = scanner.scan(); kind !== SyntaxKind.EOF; kind = scanner.scan()) {
    if (kind === SyntaxKind.CommaToken) hasComma = true;
  }
  return `${base.slice(0, lastEnd)}${hasComma ? "" : ","}${base.slice(lastEnd, close).replace(/\s*$/, "")}\n${block}\n${base.slice(close)}`;
}
