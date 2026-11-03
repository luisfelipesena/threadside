# Changelog

## 0.3.9

- In the chat, Ctrl+Tab and Ctrl+Shift+Tab move to the next and previous thread, like T3 Code's own ⇧⌘] and ⇧⌘[ (and following any remapping of those in T3 Code's keybindings).

## 0.3.8

- A new window with no folder keeps Cursor's start page: the chat no longer opens there on its own (Cursor restores it with the layout, so it is hidden once). Windows with a folder still open the chat on its thread or a draft in the window's project.

## 0.3.7

- ⌘I hides the chat without opening Cursor's own chat. The chat docked in the Primary Side Bar (moved to the right) used to be hidden by toggling the Secondary Side Bar first, which showed Cursor's agent pane there; the bar that worked last time now goes first.
- A window on a repository T3 Code does not know yet adds it as a project (`threadside.createProjectForFolder`, on by default), so the chat starts there instead of in the last project T3 Code used.
- A docked chat restored on a thread from another project starts a draft in the window's project instead.
- The managed shortcut block unbinds Cursor's "Open Chat" (`composer.startComposerPrompt`) on ⌘I itself.

## 0.3.6

- T3 Code's Working section starts off in the chat, which has no room for it in a narrow docked list. Each chat keeps its own T3 Code settings; this is set once, so turning it back on in Settings stays.

## 0.3.5

- **T3: Update T3 Code** works from the editor. Sessions now include `environment:maintain`, the scope T3 Code requires for server updates; a local session without it is replaced on the next connect, and a paired one asks you to connect again.
- A new chat starts in the T3 project whose folder is the window's folder. A window on a folder that holds other projects (a `MetaCto` window with `MetaCto/nemo` open) stays in its own project instead of the open file's.
- The chat shows as soon as a window opens, while it connects, and again if Cursor's restore puts its agent pane back. Before, Cursor's pane stayed up until the connection finished.
- Thread search (⇧⌘H) keeps the most recent activity first while you type, across sections, instead of ranking by how well the title matches.

## 0.3.4

- ⌘, or ⌘. in the chat opens T3 Code's Settings, as ⌘, does in T3 Code's desktop app (its menu never sees the key inside the editor).
- A window that reopens brings back the thread its docked chat showed, never Settings or another page; those start over in the window's project.

## 0.3.3

- T3 Code updates from the editor, nightly included. Every 30 minutes Threadside compares the server's version with T3 Code's releases on the same channel; a newer build shows an up arrow in the status bar and one **Update** offer. **T3: Update T3 Code** updates the server with T3 Code's own update call (the desktop app installs and relaunches when it runs the server), warns when threads are working, and the chat reloads into the new UI once the server is back. `threadside.checkForUpdates` turns it off.
- ⌘W in the chat closes it, like any editor tab: an editor-tab chat closes, the docked chat hides. A terminal or the right panel open in T3 Code still closes first, as in T3 Code.
- A new chat starts in the right project. The project picker is answered only with the exact project of the file you are editing (or of the window's folder), after T3 Code's palette has settled; before, a fast palette could start the thread in the most recent project instead. A window with no T3 project keeps T3 Code's start page.
- A docked chat that held a draft starts over in the window's project when the window reopens; threads still come back as they were.
- The chat shows when a window starts, in place of the agent pane Cursor reopens on every start (Cursor has no setting for that pane). The code keeps the focus. `threadside.openChatOnStartup` turns it off.

## 0.3.2

- The chat sees the editor. Each message you send carries a chip with the file in focus, the cursor or selected lines, what is on screen, the other open files and the Problems the editor shows (errors first, with their source and code). Ask "what error is the editor showing?" and the agent knows. It is read when you press Enter, so it is never stale, and attached again in a thread only after it changes. An open `@` or `/` menu still takes Enter. `threadside.sendEditorContext` turns it off.

## 0.3.1

- Thread search (⇧⌘H) groups threads the way T3 Code does: Pinned, Active, Snoozed and Settled, each with a count. Settled threads carry a check icon and say "Settled".
- Each row has a Settle button (Unsettle on a settled thread) next to Open in New Tab. The list stays open and updates in place.
- ⌘T opens the highlighted thread in a new editor tab. Cursor hands the Enter key to extensions without its modifiers, so ⌘↵ cannot be told apart from ↵; the managed shortcut block puts ⌘T ahead of any other ⌘T while the list is open.

## 0.3.0

- The chat docks on the right, in the Secondary Side Bar next to Cursor's agent, and stays there. ⌘I shows or hides it; its title bar has New Thread, Search Threads and Open in Editor Tab. `threadside.chatLocation` still opens it as an editor tab instead.
- Several threads at once: Open Thread in Editor Tab, or a middle click on a thread in T3 Code's list, opens it as its own editor tab.
- T3 Code's thread list starts filtered to the projects open in the window.
- ⌘V pastes text and images into the chat; ⌘C, ⌘X, ⌘A and ⌘Z work there; copy buttons no longer fail with "Failed to copy".
- T3: Side Chat waits for the chat to take focus before typing `/btw`.
- Threadside now always runs where the code is (the remote side of an SSH window), so a remote window uses that machine's T3 Code server.
- A chat that is not connected shows Connect and Show Log instead of a blank page.
- New icon, legible at 16 px; editor tabs for a new thread read "New Thread".

## 0.2.1

- File links open the right file when the agent wrote a bare or partial path (`observability.py:10`): Threadside searches the thread's worktree, the open workspace and the project for it, opens a single match at its line and asks when several files match.
- The T3 icon is back in the activity bar as a launcher: clicking it opens the chat beside the code, focused on the composer, and its view holds quick actions (new thread, search, review, connect). No second thread list.

## 0.2.0

- One thread list: T3 Code's own. The activity-bar list is gone, and the narrow chat starts with T3 Code's sidebar closed (⌘B brings it back).
- The chat column stays locked, so opened and dropped files go to the code column instead of splitting it.
- ⌘L adds the current file when nothing is selected; Add to T3 Chat works on several Explorer files and on editor tabs; Shift-dragging files onto the chat adds them as chips.
- Shortcuts inside the chat run editor commands from `threadside.chatShortcuts` (⌘I, ⌘N, ⇧⌘H, ⌘⇧P, ⌘P…). ⌘N in the chat starts a thread in the same repository.
- Fixed: messages from the editor to the chat were dropped (Settings opened blank, ⌘N did nothing).
- A chat that does not load says why, with Reload and Show Log; page errors go to the log.
- T3 Code's sidebar state persists inside the editor; each window keeps its own stable chat origin.
- New drawn icon.

## 0.1.1

- Windows of one editor that connect at the same moment share one T3 Code session instead of leaving an extra one behind.

## 0.1.0

First release.

- T3 Code's own chat in editor tabs beside the code, any number at once, restored after reloads, in the editor's colors and fonts.
- Zero-setup connection to a T3 Code server on the same machine, including the remote side of Remote-SSH windows; pairing links for other machines. Sessions stay in the OS keychain.
- File links open in the editor at their line, resolved against the thread's worktree.
- Selection and files become native composer chips (⌘L, Explorer menu, Shift-drag).
- Review a thread's uncommitted work or whole branch in the editor's multi-file diff.
- Thread list in the activity bar (pinned, active, snoozed, settled) with settle, snooze, wake, pin, stop and open-worktree actions.
- Thread search, new thread in the current repository, side chat (`/btw`), full-screen chat, status bar with working and waiting counts, native notifications.
- Optional takeover of Cursor's chat shortcuts (⌘I, ⌘L, ⇧⌘H, ⌘') with one managed, removable block in keybindings.json.
- Daily contract check against the newest T3 Code nightly.
