import assert from "node:assert/strict";
import { test } from "node:test";
import { parse } from "jsonc-parser";
import { BEGIN, END, renderBlock, uiPlatformOf, withBlock, withoutBlock } from "../src/keybindings/block.ts";

const block = renderBlock("mac");
const commands = (text: string) => (parse(text) as Array<{ command: string }>).map((rule) => rule.command);

test("appends after the user's rules and keeps their comments", () => {
  const text = '// mine\n[\n  // go to definition\n  { "key": "shift shift", "command": "editor.action.goToDeclaration" }\n]\n';
  const next = withBlock(text, block);
  assert.ok(next.includes("// go to definition"));
  assert.equal(commands(next)[0], "editor.action.goToDeclaration");
  assert.ok(commands(next).includes("threadside.toggleChat"));
});

test("does not add a second comma after a trailing comma or a ] inside a comment", () => {
  const text = '[\n  { "key": "a", "command": "x" }, // see ] here\n]';
  const next = withBlock(text, block);
  assert.ok(!/,\s*,/.test(next.replace(/\/\/[^\n]*/g, "")));
  assert.deepEqual(commands(next).slice(0, 1), ["x"]);
});

test("works on an empty file and an empty array", () => {
  assert.ok(commands(withBlock("", block)).includes("threadside.searchThreads"));
  assert.ok(commands(withBlock("[]", block)).includes("threadside.searchThreads"));
});

test("replacing the block is idempotent and removing it restores the file", () => {
  const text = '[\n  { "key": "a", "command": "x" }\n]\n';
  const once = withBlock(text, block);
  assert.equal(withBlock(once, block), once);
  assert.deepEqual(commands(withoutBlock(once)), ["x"]);
});

test("a begin marker without its end refuses to edit", () => {
  assert.throws(() => withoutBlock(`[\n  ${BEGIN}\n  {"key":"a","command":"x"}\n]`));
  assert.ok(END.length > 0);
});

test("the UI platform comes from the keybindings path", () => {
  assert.equal(uiPlatformOf("/Users/me/Library/Application Support/Cursor/User/keybindings.json"), "mac");
  assert.equal(uiPlatformOf("/home/me/.config/Cursor/User/keybindings.json"), "other");
  assert.ok(renderBlock("other").includes('"ctrl+i"'));
});

test("unbinds Cursor's Open Chat before giving ⌘I to the chat", () => {
  const rules = parse(`[${renderBlock("mac")}]`) as Array<{ key: string; command: string }>;
  const onI = rules.filter((rule) => rule.key === "cmd+i").map((rule) => rule.command);
  assert.deepEqual(onI, ["-composer.startComposerPrompt", "threadside.toggleChat"]);
});
