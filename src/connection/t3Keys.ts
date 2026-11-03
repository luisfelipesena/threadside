import { readFileSync } from "node:fs";
import { join } from "node:path";

/** T3 Code's defaults for the commands Threadside triggers inside the chat. */
const DEFAULTS: Record<string, string> = {
  "chat.new": "mod+n",
  "chat.newLocal": "mod+shift+n",
  "chat.find": "mod+f",
  "sidebar.toggle": "mod+b",
  "rightPanel.toggle": "mod+alt+b",
  "diff.toggle": "mod+d",
  "commandPalette.toggle": "mod+k",
  "thread.next": "mod+shift+]",
  "thread.previous": "mod+shift+[",
};

/**
 * The shortcut T3 Code uses for `command`, read from the environment's keybindings file when it is
 * on this machine, so a user's remapping keeps working from the editor.
 */
export function t3Shortcut(command: string, t3Home: string): string | undefined {
  try {
    const text = readFileSync(join(t3Home, "userdata", "keybindings.json"), "utf8").replace(/^\s*\/\/.*$/gm, "");
    const rules = JSON.parse(text) as Array<{ key?: string; command?: string; when?: string }>;
    const matches = rules.filter(
      (rule) => rule.command === command && typeof rule.key === "string" && !/\b(terminalFocus|previewFocus|modelPickerOpen)\b(?!\s*\))/.test((rule.when ?? "").replace(/!\w+/g, "")),
    );
    const removed = new Set(rules.filter((rule) => rule.command === `-${command}`).map((rule) => rule.key));
    const usable = matches.filter((rule) => !removed.has(rule.key));
    if (usable.length) return usable[usable.length - 1]!.key;
  } catch {
    // Remote environment or unreadable file: fall back to T3 Code's defaults.
  }
  return DEFAULTS[command];
}
