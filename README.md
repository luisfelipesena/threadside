# Threadside: T3 Code chat for Cursor and VS Code

> **Unofficial.** Threadside is a community extension. It is not made, endorsed or supported by T3 Tools Inc. or the T3 Code team. It needs your own [T3 Code](https://github.com/pingdotgg/t3code) server and works with no Cursor or AI subscription of its own.

Threadside puts T3 Code's chat in a locked column beside your code, the way Cursor's chat sits there, and wires it into the editor: file links open at the right line in your code column, the selection or the current file becomes context with one shortcut, and a thread's changes open in the editor's diff view.

The chat is T3 Code's own web app, served by your server, so every provider, account, worktree, side chat, device and setting T3 Code has is already there, and it updates when your server does.

![Chat beside the code](docs/images/chat.png)

## What you get

- **The full T3 Code chat beside your code.** It opens in a column to the right, in the editor's theme, background and fonts, and that column is locked: files you open, and files dropped on it, go to your code column instead of splitting the chat. Any number of chat tabs, one thread each, restored after a reload.
- **One thread list, T3 Code's own.** Pin, settle, snooze and drag work as in the app. In the narrow column the chat starts with that sidebar closed so the conversation has the room; <kbd>⌘B</kbd> or full screen brings it back. <kbd>⇧⌘H</kbd> searches every thread from anywhere.
- **Answers that read like Cursor's.** Markdown, tables, Mermaid diagrams, syntax-highlighted code with copy buttons, HTML visual replies and MCP apps, rendered by T3 Code.
- **File links that open in the editor.** Clicking `src/app.ts:42` in an answer opens that file at that line, in the thread's own worktree when it has one. Alt-click keeps T3 Code's preview.
- **Code into the chat.** <kbd>⌘L</kbd> adds the selected lines as an `app.ts:10-24` chip, or the whole file when nothing is selected. **Add to T3 Chat** in the Explorer (several files at once) and on editor tabs does the same, so does dragging files onto the chat with <kbd>Shift</kbd> held, and T3 Code's own `@` finds any file.
- **Native review.** **Review Thread Changes** opens the thread's uncommitted work, or its whole branch, in the editor's multi-file diff.
- **Side chats, forks, worktrees, devices, previews** and everything else in T3 Code work in the tab as they do in the app.
- **Remote-SSH aware.** In a remote window Threadside runs on the remote machine, finds the T3 Code server there and reaches it through the editor's own tunnel.
- **Clear when something breaks.** A chat that does not load shows why, with **Reload** and **Show Log**; page errors go to the **Threadside** output channel.

![Review a thread's changes](docs/images/review.png)

## Install

**Cursor, VSCodium, Windsurf:** search for **Threadside** in Extensions (from [Open VSX](https://open-vsx.org/extension/luisfelipesena/threadside)).

**From a release:** download `threadside-<version>.vsix` from [Releases](https://github.com/luisfelipesena/threadside/releases), then run **Extensions: Install from VSIX…**, or:

```sh
cursor --install-extension threadside-0.1.0.vsix   # or: code --install-extension …
```

Requirements: T3 Code with orchestration protocol 2 (current nightly and later releases), and Cursor 3 or VS Code 1.95 or newer.

## Connect

- **T3 Code on the same machine** (or on the machine you are connected to with Remote-SSH): nothing to do. Threadside reads the running server from `~/.t3/userdata/server-runtime.json` and creates a session for itself with the `t3` command.
- **Another machine:** run **T3: Connect to T3 Code…** and paste a pairing link from T3 Code (**Settings → Sharing & access**) or from `t3 pair`. Use the server's Tailscale HTTPS or T3 Connect address.

Each editor shows up in T3 Code under **Settings → Sharing & access** as `Threadside in <editor> (<host>)`, where you can revoke it.

## Shortcuts

Run **T3: Use T3 for Cursor Chat Shortcuts** once to give Cursor's chat keys to T3 Code. It adds one managed block to your `keybindings.json`; **T3: Restore Cursor Chat Shortcuts** removes it.

| Shortcut | Does |
|---|---|
| <kbd>⌘I</kbd> | Open the chat focused on the composer; from the chat, hide it (the conversation keeps running) |
| <kbd>⌘L</kbd> | Add the selection, or the current file, to the chat |
| <kbd>⌘N</kbd> in the chat, <kbd>⌘'</kbd> anywhere | New thread in the repository you are in |
| <kbd>⇧⌘H</kbd> | Search threads |
| <kbd>⌥⌘E</kbd> | Full-screen chat |
| <kbd>⌥⌘R</kbd> | Review the thread's changes |

Without the takeover the same commands are on <kbd>⌃⌘L</kbd> (chat), <kbd>⌃⌘H</kbd> (search), <kbd>⌃⌘N</kbd> (new thread), <kbd>⌃⌘E</kbd> and <kbd>⌃⌘R</kbd>, and every command is in the Command Palette under **T3:**.

**Inside the chat** keys belong to T3 Code (<kbd>⌘K</kbd> palette, <kbd>⌘B</kbd> sidebar, <kbd>⌘F</kbd> find, model and host pickers…), except the ones in `threadside.chatShortcuts`, which run editor commands: <kbd>⌘I</kbd>, <kbd>⌘N</kbd>, <kbd>⇧⌘H</kbd>, <kbd>⌘L</kbd>, <kbd>⌘⇧P</kbd>, <kbd>⌘P</kbd>, <kbd>⌘E</kbd>, <kbd>⌘J</kbd>, <kbd>⌘R</kbd>, <kbd>⌃`</kbd> and the view shortcuts. Edit that setting to add or give back keys.

![Search threads](docs/images/search.png)

## How it works

```
Editor ─ chat tab (webview) ─ iframe ─▶ 127.0.0.1 proxy ─▶ your T3 Code server
              ▲    bridge (postMessage)        adds the bearer token
              └── file links, selection, shortcuts, theme
Extension host ── WebSocket RPC ──▶ thread list, status, settle/snooze, review
```

- The tab shows the web app your server serves, through a small proxy on `127.0.0.1` that adds the session token. The page never sees the token.
- A bridge script, added to the page by the proxy, connects the app to the editor: it opens file links at their line, turns files and selections into composer chips, maps the chat shortcuts to editor commands, reports page errors and applies the editor's colors.
- The status bar, notifications and thread search come from T3 Code's own orchestration stream.
- A daily CI job runs `scripts/contract-check.mjs` against the newest `t3@nightly`, so a protocol or UI change upstream fails here first.

## Settings

| Setting | Default | |
|---|---|---|
| `threadside.serverUrl` | empty | A server to use instead of the one on this machine. |
| `threadside.chatLocation` | `beside` | Open the chat in a column to the right, or in the active group. |
| `threadside.threadScope` | `workspace` | Thread search lists this window's projects first, or every project equally. |
| `threadside.compactChat` | `true` | Start the narrow chat with T3 Code's thread sidebar closed. |
| `threadside.chatShortcuts` | see settings | Shortcuts that run editor commands while the chat has focus. |
| `threadside.matchEditorColors` | `true` | Use the editor's colors and fonts in the chat. |
| `threadside.openFileLinksInEditor` | `true` | Open file links in the editor (Alt-click for T3 Code's preview). |
| `threadside.notifications` | `attention` | Notify when a thread waits for you, fails or hits a usage limit. |

## Good to know

- **Cursor keeps its right-hand sidebar for its own agent**, so the chat is a locked editor column instead. <kbd>⌘I</kbd> hides it by maximizing your code column, which keeps the conversation running.
- **Drag files onto the chat with <kbd>Shift</kbd> held** to add them as chips. Cursor and VS Code pass a drag to an extension's view only while Shift is down; without it, the file simply opens in your code column (the chat column is locked, so it never splits).
- **Voice input** follows T3 Code's web app, which uses your system's dictation.
- Settled, snoozed and archived threads, usage-limit resets and side chats behave exactly as in T3 Code; see its [docs](https://github.com/pingdotgg/t3code/tree/main/docs/user).

## Troubleshooting

- **The status bar says "T3" with a plug:** no server was found. Start T3 Code, or run **T3: Connect to T3 Code…**.
- **"speaks orchestration protocol N":** update T3 Code or Threadside, whichever is older.
- **The chat shows "did not load":** press **Reload**; **Show Log** has the reason (page errors, the server's answer). Tokens are never logged.
- **Something else looks off:** **T3: Show Log** shows what Threadside did. **T3: Reconnect** starts over.

## Develop

```sh
npm install
npm run build        # dist/extension.js and dist/bridge.js
npm test             # unit tests
npm run contract     # checks a running T3 Code server (T3_URL, T3_TOKEN or the local t3 CLI)
./scripts/dev-install.sh   # packages and installs into Cursor (CLI=code for VS Code)
```

## License

MIT. T3 Code is © T3 Tools Inc. under the MIT license; Threadside does not include its code.
