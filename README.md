# Threadside: T3 Code chat for Cursor and VS Code

> **Unofficial.** Threadside is a community extension. It is not made, endorsed or supported by T3 Tools Inc. or the T3 Code team. It needs your own [T3 Code](https://github.com/pingdotgg/t3code) server and works with no Cursor or AI subscription of its own.

Threadside puts T3 Code's chat in an editor tab beside your code, the way Cursor's chat sits there, and wires it into the editor: file links open at the right line, the selection becomes context with one shortcut, a thread's changes open in the editor's diff view, and your threads live in the activity bar.

The chat is T3 Code's own web app, served by your server, so every provider, account, worktree, side chat, device and setting T3 Code has is already there, and it updates when your server does.

![Chat beside the code](docs/images/chat.png)

## What you get

- **The full T3 Code chat in a tab.** Opens in a column to the right of your code and follows the editor's theme, background and fonts. Any number of tabs, one thread each, restored after a reload.
- **Answers that read like Cursor's.** Markdown, tables, Mermaid diagrams, syntax-highlighted code with copy buttons, HTML visual replies and MCP apps, rendered by T3 Code.
- **File links that open in the editor.** Clicking `src/app.ts:42` in an answer opens that file at that line, in the thread's own worktree when it has one. Alt-click keeps T3 Code's preview.
- **Selection as context.** <kbd>⌘L</kbd> turns the selected lines into a `app.ts:10-24` chip in the composer. **Add File to Chat** in the Explorer adds a whole file. Shift-drag files from the editor into the chat.
- **Native review.** **Review Thread Changes** opens the thread's uncommitted work, or its whole branch, in the editor's multi-file diff.
- **Threads in the activity bar.** Pinned, Active, Snoozed and Settled, with live status (working, waiting for you, usage limit and its reset time). Settle, snooze, wake, pin and stop from the list.
- **Fast search.** <kbd>⇧⌘H</kbd> searches every thread by title, project or branch.
- **Side chats, forks, worktrees, devices, previews** and everything else in T3 Code work in the tab as they do in the app.
- **Remote-SSH aware.** In a remote window Threadside runs on the remote machine, finds the T3 Code server there and reaches it through the editor's own tunnel.

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

Threadside ships shortcuts that do not clash with Cursor's. Run **T3: Use T3 for Cursor Chat Shortcuts** to move Cursor's own chat keys to T3 Code (your `keybindings.json` gets one managed block; **T3: Restore Cursor Chat Shortcuts** removes it):

| Shortcut | Default | After "Use T3 for Cursor Chat Shortcuts" |
|---|---|---|
| Open or hide the chat, focused on the composer | <kbd>⌃⌘L</kbd> | <kbd>⌘I</kbd> |
| Add the selection (or focus the chat) | <kbd>⇧⌘L</kbd> | <kbd>⌘L</kbd> |
| Search threads | <kbd>⌃⌘H</kbd> | <kbd>⇧⌘H</kbd> |
| New thread in this repository | <kbd>⌘N</kbd> in the chat, <kbd>⌃⌘N</kbd> elsewhere | also <kbd>⌘'</kbd> |
| Full-screen chat | <kbd>⌃⌘E</kbd> | <kbd>⌥⌘E</kbd> |
| Review thread changes | <kbd>⌃⌘R</kbd> | <kbd>⌥⌘R</kbd> |

Every command is in the Command Palette under **T3:**, so any of them can get your own binding. Inside the chat, T3 Code's own shortcuts work (<kbd>⌘K</kbd> palette, <kbd>⌘B</kbd> sidebar, <kbd>⌘F</kbd> find, model and host pickers…). Shortcuts listed in `threadside.editorKeysInChat` always go to the editor.

![Search threads](docs/images/search.png)

## How it works

```
Editor ─ chat tab (webview) ─ iframe ─▶ 127.0.0.1 proxy ─▶ your T3 Code server
              ▲    bridge (postMessage)        adds the bearer token
              └── file links, selection, shortcuts, theme
Extension host ── WebSocket RPC ──▶ thread list, status, settle/snooze, review
```

- The tab shows the web app your server serves, through a small proxy on `127.0.0.1` that adds the session token. The page never sees the token.
- A bridge script, added to the page by the proxy, connects the app to the editor: it opens file links at their line, turns selections into composer chips, passes on shortcuts the chat does not use and applies the editor's colors.
- The thread list and status bar come from T3 Code's own orchestration stream.
- A daily CI job runs `scripts/contract-check.mjs` against the newest `t3@nightly`, so a protocol or UI change upstream fails here first.

## Settings

| Setting | Default | |
|---|---|---|
| `threadside.serverUrl` | empty | A server to use instead of the one on this machine. |
| `threadside.chatLocation` | `beside` | Open the chat in a column to the right, or in the active group. |
| `threadside.threadScope` | `workspace` | List this window's projects, or every project. |
| `threadside.matchEditorColors` | `true` | Use the editor's colors and fonts in the chat. |
| `threadside.openFileLinksInEditor` | `true` | Open file links in the editor (Alt-click for T3 Code's preview). |
| `threadside.notifications` | `attention` | Notify when a thread waits for you, fails or hits a usage limit. |
| `threadside.editorKeysInChat` | see settings | Shortcuts that reach the editor even while the chat has focus. |

## Good to know

- **Cursor keeps its right-hand sidebar for its own agent**, so the chat is an editor tab instead. <kbd>⌘I</kbd> hides it by maximizing your file group, which keeps the conversation running.
- **Drag and drop:** the editor hands drops to a webview only while <kbd>Shift</kbd> is held.
- **Voice input** follows T3 Code's web app, which uses your system's dictation.
- Settled, snoozed and archived threads, usage-limit resets and side chats behave exactly as in T3 Code; see its [docs](https://github.com/pingdotgg/t3code/tree/main/docs/user).

## Troubleshooting

- **The status bar says "T3" with a plug:** no server was found. Start T3 Code, or run **T3: Connect to T3 Code…**.
- **"speaks orchestration protocol N":** update T3 Code or Threadside, whichever is older.
- **Something looks off:** **T3: Show Log** shows what Threadside did (tokens are never logged). **T3: Reconnect** starts over.

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
