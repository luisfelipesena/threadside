# AI Trace implementation plan

## Contract

- Following starts off in every window and after reload. The visible toolbar button is the entry point.
- One pinned environment/thread per window. Another conversation suspends navigation without taking over the pin.
- Human navigation pauses following. Resume and off remain accessible. The agent keeps running.
- File activity must belong to the exact checkout. Missing targets, shell guesses, symlink escapes and unrelated worktrees never drive navigation.
- Only matching document revisions receive range highlights. Missing provider detail falls back to file-level activity.
- Public progress text may supply a brief insight. Private reasoning is not used.
- Automatically shown files do not replace the human context sent with the next prompt.
- `threadside.aiTraceAvailable: false` removes the control and disposes the runtime. Revert the isolated feature commit or reinstall 0.3.21 for a complete rollback.

## Implementation and acceptance

- [x] Separate activity decoding and range validation from the native editor controller.
- [x] Add the host-owned toolbar, local environment checks and caller-owned subscription cancellation.
- [x] Cover off-state inactivity, thread/environment isolation, stale sequence handling, snapshots, manual pause and reconnect in tests.
- [x] Preserve user context and reject pending context submissions after conversation navigation.
- [x] Validate the built extension in native VS Code and Cursor, including focus, theme, switch and kill-switch behavior.
- [x] Package 0.4.0, preserve the 0.3.21 VSIX and install on the four existing MacServer editor/SSH hosts.
- [ ] Install on the two Air desktop editors when the Air is reachable. SSH and tailnet ping timed out during rollout.
- [x] Record checksums and final validation, remove the owned provider worktrees and native QA windows, and prepare one reversible feature commit.

## Provider boundaries

Earlier live probes exercised GPT/Codex, Claude, Gemini through Antigravity and Grok. Codex shell reads do not expose exact targets in the consumed event. Antigravity may omit ranges, patches and read-failure details. The extension preserves those limits rather than synthesizing precision. Embedded child panes do not replace the route's pin; open a child as its own thread to follow it.

No database, provider configuration or global editor settings are migrated by this feature. Native evidence and test fixtures stay outside the repository.

## Validation

- 55 unit and contract-fixture tests passed, plus TypeScript and the live server contract check.
- 14 native VS Code cases passed using real captured provider events with an isolated transport fixture. They include checkout changes in the thread and IDE worktrees, metadata mismatch, stale events, reconnect, context preservation and the kill switch.
- Cursor followed the exact worktree independently of the VS Code window. A real typed draft kept keyboard focus across a native file change. Light and high-contrast screenshots were inspected.
- Branch tests used disposable test worktrees. The main workspace branch was not switched. Temporary test branches were restored and removed.
- The earlier live provider experiments remain the evidence for GPT, Claude, Gemini and Grok transport differences. Native fixture replay does not claim another live model execution.
