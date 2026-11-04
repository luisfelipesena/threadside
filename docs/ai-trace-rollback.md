# AI Trace rollback

Following is opt-in, window-local and never saved. It starts off after an editor reload. It does not write project files, change T3 providers, modify conversation history or require a database migration.

## Stop or remove the feature

1. Click the active **Following** button. This cancels the activity subscription and pending navigation and clears its decorations. It does not stop the agent.
2. To hide the control and dispose the observer entirely, set `threadside.aiTraceAvailable` to `false` in the editor settings. Set it back to `true` to restore the button, still off.
3. To restore the previous binary, install the saved `threadside-0.3.21.vsix` through **Extensions: Install from VSIX...**, then reload the window. For Remote-SSH, install it on the SSH extension host as well. Disable automatic updates for Threadside while testing a rollback.

CLI equivalent, using the CLI for the editor and host being restored:

```sh
code --install-extension /path/to/threadside-0.3.21.vsix --force
cursor --install-extension /path/to/threadside-0.3.21.vsix --force
```

The release evidence retains the previous VSIX and checksums. Do not delete user settings, T3 data or other extensions during rollback.

## Remove it from source

Revert the isolated `feat: add opt-in AI Trace` commit, then rebuild and package with a new version number if publishing a replacement. Its implementation is in `src/native/aiTrace.ts` and `src/native/traceActivity.ts`, with host toolbar and controller wiring. No feature state or project data needs migration or deletion.

The editor may keep tabs that following opened. They are ordinary file tabs. Leaving them open preserves any subsequent user work.
