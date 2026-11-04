import { parse } from "jsonc-parser";

/**
 * The editor never sees keys typed inside the chat's frame, so the chat forwards a fixed list of chords
 * (`threadside.chatShortcuts`). The user's own keybindings.json rules for Threadside commands join that
 * list, so rebinding a command (for example ⌘I for the chat) works from inside the chat too.
 */
export function withUserChatKeys(
  base: Record<string, string>,
  keybindingsText: string | undefined,
  platform: "mac" | "other",
): Record<string, string> {
  const map = { ...base };
  const rules = keybindingsText ? (parse(keybindingsText) as unknown) : undefined;
  if (!Array.isArray(rules)) return map;
  for (const rule of rules as Array<{ key?: unknown; command?: unknown }>) {
    if (typeof rule?.key !== "string" || typeof rule.command !== "string") continue;
    const removal = rule.command.startsWith("-");
    const command = removal ? rule.command.slice(1) : rule.command;
    if (!command.startsWith("threadside.")) continue;
    const chord = bridgeChord(rule.key, platform);
    if (!chord) continue;
    if (!removal) map[chord] = command;
    else if (map[chord] === command) delete map[chord];
  }
  return map;
}

/** `cmd+i` in keybindings.json is `mod+i` in the chat (see the bridge's `chord`); chord sequences are skipped. */
export function bridgeChord(key: string, platform: "mac" | "other"): string | undefined {
  const parts = key.trim().toLowerCase().split("+");
  if (parts.some((part) => !part || /\s/.test(part))) return undefined;
  const name = parts.pop() as string;
  const mods = new Set<string>();
  for (const part of parts) {
    if (part === "cmd" || part === "meta" || part === "win") {
      if (platform !== "mac") return undefined;
      mods.add("mod");
    } else if (part === "ctrl") mods.add(platform === "mac" ? "ctrl" : "mod");
    else if (part === "alt" || part === "option") mods.add("alt");
    else if (part === "shift") mods.add("shift");
    else return undefined;
  }
  // The chat forwards only chords with a modifier; plain keys belong to T3 Code.
  if (!mods.has("mod") && !mods.has("ctrl") && !mods.has("alt")) return undefined;
  return [...["mod", "ctrl", "alt", "shift"].filter((mod) => mods.has(mod)), name].join("+");
}
