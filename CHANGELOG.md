# Changelog

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
