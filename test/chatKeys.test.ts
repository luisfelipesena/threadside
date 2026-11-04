import assert from "node:assert/strict";
import { test } from "node:test";
import { bridgeChord, withUserChatKeys } from "../src/keybindings/chatKeys.ts";

const defaults = { "mod+i": "threadside.toggleChat", "mod+p": "workbench.action.quickOpen" };

test("a key the user binds to a Threadside command also works inside the chat", () => {
  const text = '[\n  // mine\n  { "key": "cmd+j", "command": "threadside.toggleChat" },\n  { "key": "cmd+k", "command": "editor.action.other" }\n]';
  assert.deepEqual(withUserChatKeys(defaults, text, "mac"), { ...defaults, "mod+j": "threadside.toggleChat" });
});

test("removing a default binding in keybindings.json removes it from the chat, and later rules win", () => {
  const text = '[{ "key": "cmd+i", "command": "-threadside.toggleChat" }, { "key": "cmd+i", "command": "threadside.newThread" }]';
  assert.deepEqual(withUserChatKeys(defaults, text, "mac"), { ...defaults, "mod+i": "threadside.newThread" });
  assert.deepEqual(withUserChatKeys(defaults, '[{ "key": "cmd+i", "command": "-threadside.toggleChat" }]', "mac"), { "mod+p": "workbench.action.quickOpen" });
});

test("a missing or broken keybindings.json leaves the setting as it is", () => {
  assert.deepEqual(withUserChatKeys(defaults, undefined, "mac"), defaults);
  assert.deepEqual(withUserChatKeys(defaults, "{ not an array", "mac"), defaults);
});

test("editor key names become the chat's chord names on each platform", () => {
  assert.equal(bridgeChord("cmd+i", "mac"), "mod+i");
  assert.equal(bridgeChord("ctrl+i", "other"), "mod+i");
  assert.equal(bridgeChord("shift+alt+cmd+E", "mac"), "mod+alt+shift+e");
  assert.equal(bridgeChord("ctrl+cmd+l", "mac"), "mod+ctrl+l");
  assert.equal(bridgeChord("cmd+k cmd+i", "mac"), undefined);
  assert.equal(bridgeChord("f5", "mac"), undefined);
  assert.equal(bridgeChord("cmd+i", "other"), undefined);
});
