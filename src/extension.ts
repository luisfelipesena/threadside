import { existsSync } from "node:fs";
import { basename, join, relative as relativePath } from "node:path";
import * as vscode from "vscode";
import { resolveT3Home } from "./connection/discovery";
import { Environment, parsePairingInput } from "./connection/environment";
import { notificationTag, sidebarProjectKey } from "./connection/projectKey";
import { isRunning, isSettled, limitResetAt, type ProjectShell, type ThreadShell } from "./connection/shell";
import { canSelfUpdate, newerRelease, ReleaseFeed } from "./connection/updates";
import { t3Shortcut } from "./connection/t3Keys";
import { restoreShortcuts, takeOverShortcuts } from "./keybindings/takeover";
import { log, redact } from "./log";
import { isInside, mentionFor } from "./native/fileLinks";
import { type EditorSnapshot, ideContext, type Problem } from "./native/ideContext";
import { resolveFileLink } from "./native/resolveFile";
import { reviewChanges } from "./native/review";
import { lockChatGroup } from "./native/chatDock";
import { statusLabel } from "./native/threadInfo";
import { isOpenInTab, type ThreadItem, threadPickerItems } from "./native/threadPicker";
import { AuthProxy } from "./proxy/authProxy";
import { threadIdFromPath, threadPath } from "./routes";
import { type BridgeMessage, ChatPanel, SIDE_VIEW_ID, setExtensionUri, VIEW_TYPE } from "./webview/chatPanel";

const PORT_KEY = "threadside.proxyPort";
const DOCKED_KEY = "threadside.dockedOnRight";
/** The command that last hid the docked chat, which tells where the user keeps it. */
const CLOSER_KEY = "threadside.dockCloser";

export function activate(context: vscode.ExtensionContext): void {
  setExtensionUri(context.extensionUri);
  const controller = new Controller(context);
  context.subscriptions.push(controller);
  void controller.start();
}

export function deactivate(): void {}

class Controller implements vscode.Disposable {
  private readonly environment: Environment;
  private readonly proxy: AuthProxy;
  private readonly statusItem: vscode.StatusBarItem;
  private readonly panels = new Set<ChatPanel>();
  private activePanel: ChatPanel | undefined;
  private originPromise: Promise<string> | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly lastSeen = new Map<string, ThreadShell>();
  private readonly releases = new ReleaseFeed();
  /** A newer T3 Code than the connected server runs, on the server's channel. */
  private availableUpdate: string | undefined;
  private serverVersion: string | undefined;
  private scope: "workspace" | "all";
  /** The last text editor, so commands still find it after focus moves to the chat. */
  private lastTextEditor: vscode.TextEditor | undefined = vscode.window.activeTextEditor;
  /** T3 Code's own "Thread notifications" choice, reported by the chat; while it notifies, Threadside does not. */
  private t3NotificationMode: string | undefined;
  /** The projects T3 Code's thread list is filtered to in this window's chat; empty means every project. */
  private t3ScopeKeys: string[] | undefined;
  /** When each T3 Code notification was last shown, so every open chat reporting the same one shows it once. */
  private readonly shownNotifications = new Map<string, number>();
  /** Set once the user hides the docked chat, so the startup guard leaves it hidden. */
  private userHidSideView = false;
  /** Set when ⌘I hid the chat by maximizing the file group. */
  private chatHidden = false;
  /** The docked chat, once the editor has shown its view. */
  private sideView: ChatPanel | undefined;
  private sideViewWaiters: Array<(chat: ChatPanel) => void> = [];
  /** The open ⇧⌘H picker, for ⌘T. (Its Enter key reaches extensions without modifiers, so ⌘↵ cannot be told apart.) */
  private threadPicker: { openActiveInTab(): void } | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.environment = new Environment(context.secrets);
    this.proxy = new AuthProxy(vscode.Uri.joinPath(context.extensionUri, "dist", "bridge.js").fsPath);
    this.scope = config().get("threadScope", "workspace");
    // T3 Code's thread list starts filtered to the projects open in this window.
    this.proxy.boot = () => ({ projectScopeKeys: this.projectScopeKeys() });
    this.statusItem = vscode.window.createStatusBarItem("threadside.status", vscode.StatusBarAlignment.Right, 1000);
    this.statusItem.name = "T3 Code";
    this.statusItem.command = "threadside.toggleChat";
    this.disposables.push(this.environment, this.statusItem, this.proxy);
  }

  async start(): Promise<void> {
    this.registerCommands();
    this.disposables.push(
      vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
        deserializeWebviewPanel: async (panel, state) => {
          this.adopt(new ChatPanel(panel, this.chatHost(), state as { path?: string } | undefined));
        },
      }),
      vscode.window.registerWebviewViewProvider(
        SIDE_VIEW_ID,
        { resolveWebviewView: (view, context) => this.adoptSideView(view, context.state as { path?: string } | undefined) },
        { webviewOptions: { retainContextWhenHidden: true } },
      ),
      vscode.window.registerUriHandler({ handleUri: (uri) => this.handleUri(uri) }),
      this.environment.onDidChangeStatus((status) => {
        if (status.kind === "connected") {
          this.proxy.setTarget(status.target);
          // Reload only tabs that show another server or the "not connected" page, or every tab once the
          // server runs a new build (its UI comes with it); a brief drop keeps the UI as it was.
          const upgraded = this.serverVersion !== undefined && this.serverVersion !== status.descriptor.serverVersion;
          this.serverVersion = status.descriptor.serverVersion;
          for (const panel of this.panels) if (upgraded || panel.renderedFor !== status.httpBaseUrl) void panel.render(status.httpBaseUrl);
          void this.checkForUpdate();
        } else if (status.kind === "needs-pairing") {
          this.proxy.setTarget(undefined);
        }
        // A tab still waiting for the first connection swaps "Connecting…" for the Connect page.
        if (status.kind === "needs-pairing" || status.kind === "error") for (const panel of this.panels) if (!panel.renderedFor) void panel.render();
        this.updateStatus();
      }),
      this.environment.shell.onDidChange((ids) => {
        this.notify(ids);
        this.updateStatus();
        this.updatePanelTitles();
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("threadside.serverUrl") || event.affectsConfiguration("threadside.t3Home")) {
          void this.environment.connect();
        }
      }),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor) this.lastTextEditor = editor;
      }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => void this.environment.connect()),
    );
    this.updateStatus();
    if (!vscode.workspace.isTrusted) {
      this.statusItem.text = "$(shield) T3";
      this.statusItem.tooltip = "Threadside connects after you trust this workspace.";
      this.statusItem.show();
      return;
    }
    await this.dockOnRightOnce();
    // The chat shows while the connection is made, so Cursor's own pane is on screen as briefly as possible.
    // A window with no folder is not a project to chat about: it keeps Cursor's start page.
    if (!vscode.workspace.workspaceFolders?.length) void this.hideChatInEmptyWindow();
    else if (config().get("openChatOnStartup", true)) void this.showChatOnStartup();
    await this.environment.connect();
    // T3 Code's desktop app looks for builds every few minutes; GitHub allows 60 unauthenticated calls an hour.
    const updates = setInterval(() => void this.checkForUpdate(), 30 * 60_000);
    this.disposables.push({ dispose: () => clearInterval(updates) });
  }

  /**
   * Cursor restores its own agent pane in the right-hand sidebar whenever the sidebar's last view comes
   * from an extension that is not loaded yet (always, in a Remote-SSH window), and has no setting to stop
   * it. The chat takes that place as soon as the extension starts, again if the restore takes it back,
   * and the code keeps the focus.
   */
  private async showChatOnStartup(): Promise<void> {
    if (sideLocation() !== "side") {
      await this.openChat({ preserveFocus: true }).catch((error: Error) => log().warn(`Could not show the chat: ${error.message}`));
      return;
    }
    // Cursor switches its sidebar to its own agent a few seconds after start, and the chat's view still
    // reports itself visible behind it, so the chat's tab is brought forward at fixed points of startup.
    // Focus goes back to the code each time; a chat the user hid stays hidden.
    for (const at of [300, 2500, 6000]) {
      await new Promise((resolve) => setTimeout(resolve, at));
      if (this.userHidSideView) return;
      await vscode.commands.executeCommand(`${SIDE_VIEW_ID}.focus`).then(undefined, (error: Error) => log().warn(`Could not show the chat: ${error.message}`));
      await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
    }
  }

  /** The editor restores the docked chat with the layout, even in a new empty window; hide it there once. */
  private async hideChatInEmptyWindow(): Promise<void> {
    for (const wait of [300, 1500]) {
      await new Promise((resolve) => setTimeout(resolve, wait));
      if (this.sideView?.visible) return this.hideSideView();
    }
  }

  /**
   * Cursor keeps extensions out of its Secondary Side Bar, but a view can still be moved there and
   * the editor remembers where. On first run the chat moves to the right, like Cursor's own chat;
   * moving it anywhere else later is the user's choice and stays.
   */
  private async dockOnRightOnce(): Promise<void> {
    if (sideLocation() !== "side" || this.context.globalState.get(DOCKED_KEY)) return;
    await this.context.globalState.update(DOCKED_KEY, true);
    await this.context.globalState.update(CLOSER_KEY, "workbench.action.toggleAuxiliaryBar");
    try {
      // For a view alone in its Side Bar container the destination picker lists "New Panel Entry",
      // then "New Secondary Side Bar Entry".
      await vscode.commands.executeCommand("workbench.action.moveFocusedView", SIDE_VIEW_ID);
      await vscode.commands.executeCommand("quickInput.next");
      await vscode.commands.executeCommand("workbench.action.acceptSelectedQuickOpenItem");
      log().info("Moved the chat to the Secondary Side Bar.");
    } catch (error) {
      log().warn(`Could not move the chat to the Secondary Side Bar: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private adoptSideView(view: vscode.WebviewView, state: { path?: string } | undefined): void {
    const saved = state?.path ?? this.context.workspaceState.get<string>("threadside.sidePath");
    // A thread comes back as it was. A draft, Settings or an empty chat starts over in the repository this window
    // is coding in, so a draft another project left behind never opens here.
    const thread = saved && /^\/[^/]+\/[^/]+$/.test(saved) && !/^\/(draft|settings)\//.test(saved) ? saved : undefined;
    const chat = new ChatPanel(view, this.chatHost(), { path: thread ?? "/" });
    this.sideView = chat;
    chat.onFirstReady = () => void (thread ? this.keepThreadOrStartDraft(chat, thread) : this.startDraft(chat));
    chat.onDidDispose(() => {
      if (this.sideView === chat) this.sideView = undefined;
    });
    this.adopt(chat);
    for (const resolve of this.sideViewWaiters.splice(0)) resolve(chat);
  }

  /** Shows the docked chat, asking the editor to create its view the first time. */
  private async showSideView(preserveFocus = false): Promise<ChatPanel> {
    if (this.sideView) {
      this.sideView.reveal(preserveFocus);
      return this.sideView;
    }
    const ready = new Promise<ChatPanel>((resolve, reject) => {
      this.sideViewWaiters.push(resolve);
      setTimeout(() => reject(new Error("The chat view did not open.")), 10_000);
    });
    await vscode.commands.executeCommand(`${SIDE_VIEW_ID}.focus`);
    return ready;
  }

  /** T3 Code thread-list keys for the projects open in this window (see `scopeProjects`). */
  private projectScopeKeys(): string[] | undefined {
    const environmentId = this.environment.descriptor?.environmentId;
    const scope = this.scopeProjects();
    if (!environmentId || !scope) return undefined;
    const keys = [...scope]
      .map((id) => this.environment.shell.projects.get(id))
      .filter((project) => project && !project.isScratch && !project.archivedAt)
      .map((project) => sidebarProjectKey(project!, environmentId));
    return keys.length ? [...new Set(keys)].sort() : undefined;
  }

  // ---------------------------------------------------------------- panels

  private chatHost() {
    return {
      environment: this.environment,
      proxy: this.proxy,
      proxyOrigin: () => this.proxyOrigin(),
      onBridgeMessage: (panel: ChatPanel, message: BridgeMessage) => this.onBridgeMessage(panel, message),
      onPanelChanged: () => this.onPanelChanged(),
    };
  }

  /** The proxy origin as the webview reaches it; over Remote-SSH this is a forwarded port. */
  private proxyOrigin(): Promise<string> {
    this.originPromise ??= (async () => {
      // Per window: the iframe origin includes the port, and T3 Code keeps local UI state per origin.
      const port = await this.proxy.start(this.context.workspaceState.get<number>(PORT_KEY));
      await this.context.workspaceState.update(PORT_KEY, port);
      const external = await vscode.env.asExternalUri(vscode.Uri.parse(`http://127.0.0.1:${port}`));
      const origin = new URL(external.toString(true)).origin;
      this.proxy.allowOrigin(origin);
      log().info(`Chat proxy on 127.0.0.1:${port}, reached as ${origin}.`);
      return origin;
    })();
    return this.originPromise;
  }

  private adopt(panel: ChatPanel): ChatPanel {
    this.panels.add(panel);
    this.activePanel = panel;
    panel.onDidDispose(() => {
      this.panels.delete(panel);
      if (this.activePanel === panel) this.activePanel = [...this.panels].pop();
      this.onPanelChanged();
    });
    this.onPanelChanged();
    return panel;
  }

  private async openChat(options: { path?: string; newTab?: boolean; preserveFocus?: boolean } = {}): Promise<ChatPanel> {
    // The chat in focus keeps the request; otherwise a visible thread tab; otherwise the docked chat.
    const tabs = [...this.panels].filter((panel) => !panel.isSideView);
    const tab = this.activePanel?.panel && this.activePanel.visible ? this.activePanel : tabs.find((panel) => panel.active);
    const existing = options.newTab
      ? undefined
      : this.activePanel?.active
        ? this.activePanel
        : sideLocation() === "side"
          ? (tab ?? (await this.showSideView(options.preserveFocus)))
          : (tab ?? this.activePanel ?? tabs[0]);
    if (existing) {
      if (options.path) existing.navigate(options.path);
      existing.reveal(options.preserveFocus);
      return existing;
    }
    const beside = sideLocation() !== "active";
    const groupsBefore = vscode.window.tabGroups.all.length;
    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      "T3",
      { viewColumn: beside ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active, preserveFocus: options.preserveFocus ?? false },
      { enableScripts: true, retainContextWhenHidden: true, enableFindWidget: false },
    );
    const chat = this.adopt(new ChatPanel(panel, this.chatHost(), { path: options.path ?? "/" }));
    // A fresh chat with no thread starts a draft in the repository this window is coding in.
    if (!options.path) chat.onFirstReady = () => void this.startDraft(chat);
    // Like Cursor's chat: a narrow column on the right that keeps file tabs out of it.
    if (beside && groupsBefore === 1 && vscode.window.tabGroups.all.length === 2) {
      await vscode.commands.executeCommand("vscode.setEditorLayout", { orientation: 0, groups: [{ size: 0.64 }, { size: 0.36 }] });
      await lockChatGroup(isChatTab);
    }
    return chat;
  }

  private onPanelChanged(): void {
    const active = [...this.panels].find((panel) => panel.active);
    if (active) {
      this.activePanel = active;
      if (active.panel) void lockChatGroup(isChatTab);
    }
    if (this.sideView?.path) void this.context.workspaceState.update("threadside.sidePath", this.sideView.path);
    const thread = this.activeThread();
    void vscode.commands.executeCommand("setContext", "threadside.activeHasWorktree", Boolean(thread && this.threadDir(thread)));
    this.updatePanelTitles();
    this.updateStatus();
  }

  private updatePanelTitles(): void {
    for (const panel of this.panels) {
      const id = panel.threadId;
      const thread = id ? this.environment.shell.threads.get(id) : undefined;
      const title = thread?.title ?? (panel.path.startsWith("/settings") ? "T3 Settings" : "New Thread");
      panel.setTitle(panel.isSideView && !thread ? "" : title);
    }
  }

  private activeThread(): ThreadShell | undefined {
    const id = this.activePanel?.threadId;
    return id ? this.environment.shell.threads.get(id) : undefined;
  }

  // ---------------------------------------------------------------- bridge

  private onBridgeMessage(panel: ChatPanel, message: BridgeMessage): void {
    switch (message.type) {
      case "openFile":
        this.openFile(panel, String(message.href ?? ""), Boolean(message.beside)).catch((error: unknown) => log().error(`Could not open the file link: ${error instanceof Error ? error.message : String(error)}`));
        break;
      case "closeChat":
        if (message.launcherOpen) this.runT3Shortcut(panel, "rightPanel.toggle");
        else if (panel.panel) panel.panel.dispose();
        else void this.hideSideView();
        break;
      case "openExternal":
        if (typeof message.url === "string" && /^https?:\/\//.test(message.url)) {
          void vscode.env.openExternal(vscode.Uri.parse(message.url));
        }
        break;
      case "droppedUris": {
        const mentions: string[] = [];
        for (const raw of Array.isArray(message.uris) ? (message.uris as unknown[]) : []) {
          if (typeof raw !== "string") continue;
          try {
            mentions.push(mentionFor(this.mentionPath(vscode.Uri.parse(raw).fsPath)));
          } catch {
            // ignore unparsable entries
          }
        }
        log().info(`Dropped ${mentions.length} file(s) into the chat.`);
        if (mentions.length) panel.insertMentions(mentions.slice(0, 50));
        break;
      }
      case "command":
        if (message.command === "newThread") void this.newThread();
        break;
      case "dragTypes":
        log().debug(`Drag over chat with types: ${String(message.types)}`);
        break;
      case "focus":
        this.activePanel = panel;
        this.onPanelChanged();
        break;
      case "copyText":
        if (typeof message.text === "string") {
          void vscode.env.clipboard.writeText(message.text);
          vscode.window.setStatusBarMessage("$(check) Copied", 1500);
        }
        break;
      case "openThreadInTab":
        if (typeof message.threadId === "string" && message.environmentId === this.environment.descriptor?.environmentId) {
          void this.openThread(message.threadId, true);
        }
        break;
      case "notificationMode":
        if (typeof message.mode === "string") this.t3NotificationMode = message.mode;
        this.t3ScopeKeys = scopeKeysOf(message.scopeKeys);
        break;
      case "notification":
        this.showT3Notification(panel, message);
        break;
      case "ideContextRequest": {
        const snapshot = config().get("sendEditorContext", true) ? this.editorSnapshot() : undefined;
        const environmentId = this.environment.descriptor?.environmentId;
        panel.post({ type: "ideContext", requestId: message.requestId, context: snapshot && environmentId ? { ...ideContext(snapshot), environmentId } : null });
        break;
      }
      default:
        break;
    }
  }

  /** The editor the user was last in (the chat itself has focus while they type to it). */
  private editorSnapshot(): EditorSnapshot | undefined {
    const editor = vscode.window.activeTextEditor ?? this.lastTextEditor;
    const document = editor?.document;
    if (!editor || !document || document.isClosed || !isDiskFile(document.uri)) return undefined;
    const problemsOf = (uri: vscode.Uri): Problem[] =>
      vscode.languages
        .getDiagnostics(uri)
        .filter((diagnostic) => diagnostic.severity <= vscode.DiagnosticSeverity.Warning)
        .map((diagnostic) => ({
          severity: diagnostic.severity === vscode.DiagnosticSeverity.Error ? "error" : "warning",
          line: diagnostic.range.start.line + 1,
          column: diagnostic.range.start.character + 1,
          message: diagnostic.message,
          source: diagnostic.source,
          code: typeof diagnostic.code === "object" ? String(diagnostic.code.value) : diagnostic.code === undefined ? undefined : String(diagnostic.code),
        }));
    const open = new Map<string, vscode.Uri>();
    for (const tab of vscode.window.tabGroups.all.flatMap((group) => group.tabs)) {
      if (tab.input instanceof vscode.TabInputText && isDiskFile(tab.input.uri)) open.set(tab.input.uri.fsPath, tab.input.uri);
    }
    const selection = editor.selection;
    const position = (at: vscode.Position) => ({ line: at.line + 1, column: at.character + 1 });
    const visible = editor.visibleRanges;
    return {
      ide: vscode.env.appName,
      file: document.uri.fsPath,
      language: document.languageId,
      cursor: position(selection.active),
      selection: selection.isEmpty ? undefined : { start: position(selection.start), end: position(selection.end) },
      visible: visible.length ? { start: visible[0]!.start.line + 1, end: visible[visible.length - 1]!.end.line + 1 } : undefined,
      dirty: document.isDirty,
      openFiles: [...open.keys()],
      problems: problemsOf(document.uri),
      otherProblems: [...open]
        .filter(([file]) => file !== document.uri.fsPath)
        .map(([file, uri]) => {
          const problems = problemsOf(uri);
          const errors = problems.filter((problem) => problem.severity === "error").length;
          return { file, errors, warnings: problems.length - errors };
        }),
    };
  }

  private async openFile(panel: ChatPanel, href: string, beside: boolean): Promise<void> {
    const threadId = threadIdFromPath(panel.path);
    const thread = threadId ? this.environment.shell.threads.get(threadId) : undefined;
    // Most specific first: the thread's own worktree, the code open in this window, then the project root.
    const bases = [
      thread?.worktreePath ?? undefined,
      ...(vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
      thread ? this.environment.shell.projects.get(thread.projectId)?.workspaceRoot : undefined,
    ].filter((base): base is string => Boolean(base));
    const target = await resolveFileLink(href, bases, (path) => this.workspaceUri(path));
    if (!target) return;
    const uri = this.workspaceUri(target.path);
    const viewColumn = beside ? vscode.ViewColumn.Beside : this.fileColumn();
    // Without a line, the editor's own viewer for the type opens it: images and PDFs cannot open as text.
    if (target.line === undefined) {
      await vscode.commands.executeCommand("vscode.open", uri, { viewColumn, preview: false });
      return;
    }
    const line = Math.max(0, target.line - 1);
    const start = new vscode.Position(line, Math.max(0, (target.column ?? 1) - 1));
    const end = target.endLine ? new vscode.Position(Math.max(line, target.endLine - 1), Number.MAX_SAFE_INTEGER) : start;
    const document = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(document, { viewColumn, selection: new vscode.Range(start, end), preview: false });
    editor.revealRange(new vscode.Range(start, end), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  /** The editor group for files: the first group that does not hold a chat tab. */
  private fileColumn(): vscode.ViewColumn {
    for (const group of vscode.window.tabGroups.all) {
      const holdsChat = group.tabs.some(isChatTab);
      if (!holdsChat) return group.viewColumn;
    }
    return vscode.ViewColumn.One;
  }

  /** Focuses the file group so editor-opening commands (diffs, reviews) land beside the chat, not in it. */
  private async focusFileGroup(): Promise<void> {
    const names = ["First", "Second", "Third", "Fourth", "Fifth", "Sixth", "Seventh", "Eighth"];
    const name = names[this.fileColumn() - 1];
    if (name) await vscode.commands.executeCommand(`workbench.action.focus${name}EditorGroup`);
  }

  /** A URI on the workspace's file system, so Remote-SSH windows open the remote file. */
  private workspaceUri(path: string): vscode.Uri {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    return folder && folder.scheme !== "file" ? folder.with({ path }) : vscode.Uri.file(path);
  }

  private threadDir(thread: ThreadShell): string | undefined {
    return thread.worktreePath ?? this.environment.shell.projects.get(thread.projectId)?.workspaceRoot;
  }

  /** Paths relative to the active thread's checkout when inside it; absolute otherwise. */
  private mentionPath(path: string): string {
    const thread = this.activeThread();
    // The agent runs in the thread's checkout, else in its project's root, so paths are relative to that.
    const roots = [
      thread && this.threadDir(thread),
      this.environment.shell.projectForPath(path)?.workspaceRoot,
      ...(vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
    ];
    for (const root of roots) {
      if (root && isInside(root, path) && root !== path) return relativePath(root, path).split("\\").join("/");
    }
    return path;
  }

  // ---------------------------------------------------------------- commands

  private registerCommands(): void {
    const command = (id: string, handler: (...args: never[]) => unknown) =>
      this.disposables.push(
        vscode.commands.registerCommand(id, async (...args: never[]) => {
          try {
            await handler(...args);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            log().error(`${id}: ${redact(message)}`);
            void vscode.window.showErrorMessage(`T3: ${message}`);
          }
        }),
      );

    command("threadside.openChat", () => this.openChat());
    command("threadside.toggleChat", () => this.toggleChat());
    command("threadside.updateServer", () => this.updateServer());
    command("threadside.focusComposer", async () => (await this.openChat()).focusComposer());
    // ⌘L, like Cursor: the selection (or, with none, the whole file) goes to the chat as a chip;
    // from the chat itself it just focuses the composer.
    command("threadside.focusOrAddSelection", async () => {
      const editor = vscode.window.activeTextEditor;
      if (editor && editor.selections.some((selection) => !selection.isEmpty)) return this.addSelection();
      const chat = await this.openChat();
      if (editor) chat.insertMentions([mentionFor(this.mentionPath(editor.document.uri.fsPath))]);
      else chat.focusComposer();
    });
    command("threadside.newThread", () => this.newThread());
    command("threadside.newThreadInTab", () => this.openChat({ newTab: true }));
    command("threadside.searchThreads", () => this.searchThreads());
    command("threadside.openPickedThreadInTab", () => this.threadPicker?.openActiveInTab());
    command("threadside.addSelection", () => this.addSelection());
    command("threadside.addFile", async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
      const targets = uris?.length ? uris : uri ? [uri] : [(vscode.window.activeTextEditor ?? this.lastTextEditor)?.document.uri].filter(Boolean);
      const files = (targets as vscode.Uri[]).filter((target) => target.scheme === "file" || target.scheme === "vscode-remote");
      if (!files.length) return;
      const chat = await this.openChat();
      chat.insertMentions(files.slice(0, 50).map((file) => mentionFor(this.mentionPath(file.fsPath))));
    });
    command("threadside.toggleMaximize", async () => {
      // The docked chat fills the window where it sits when that is the Secondary Side Bar; elsewhere its
      // thread opens as a full editor tab. A tab maximizes its group.
      if (this.activePanel?.isSideView || (sideLocation() === "side" && !this.activePanel?.panel?.active)) {
        if (await this.maximizeSideBar()) return;
        return this.popOut();
      }
      if (!this.activePanel?.panel?.active) await this.openChat();
      await vscode.commands.executeCommand("workbench.action.toggleMaximizeEditorGroup");
    });
    command("threadside.popOut", () => this.popOut());
    command("threadside.dockOnRight", () => vscode.commands.executeCommand("workbench.action.moveFocusedView", SIDE_VIEW_ID));
    command("threadside.sideChat", async () => {
      const chat = await this.openChat();
      chat.insert("/btw ");
    });
    command("threadside.reviewChanges", async (node?: { thread?: ThreadShell }) => {
      const thread = node?.thread ?? this.activeThread();
      const dir = thread && this.threadDir(thread);
      if (!thread || !dir) {
        void vscode.window.showInformationMessage("Open a thread that works in a checkout to review its changes.");
        return;
      }
      await this.focusFileGroup();
      await reviewChanges(dir, thread.title, (path) => this.workspaceUri(path));
    });
    command("threadside.openWorktree", async (node?: { thread?: ThreadShell }) => {
      const thread = node?.thread ?? this.activeThread();
      const dir = thread && this.threadDir(thread);
      if (dir) await vscode.commands.executeCommand("vscode.openFolder", this.workspaceUri(dir), { forceNewWindow: true });
    });
    command("threadside.stop", (node?: { thread?: ThreadShell }) => this.threadCommand(node, (id) => ({ type: "thread.stop", threadId: id })));
    command("threadside.settle", (node?: { thread?: ThreadShell }) => this.threadCommand(node, (id) => ({ type: "thread.settle", threadId: id })));
    command("threadside.unsettle", (node?: { thread?: ThreadShell }) =>
      this.threadCommand(node, (id) => ({ type: "thread.unsettle", threadId: id, reason: "user" })),
    );
    command("threadside.wake", (node?: { thread?: ThreadShell }) =>
      this.threadCommand(node, (id) => ({ type: "thread.unsnooze", threadId: id, reason: "user" })),
    );
    command("threadside.pin", (node?: { thread?: ThreadShell }) => this.threadCommand(node, (id) => ({ type: "thread.pin", threadId: id })));
    command("threadside.unpin", (node?: { thread?: ThreadShell }) => this.threadCommand(node, (id) => ({ type: "thread.unpin", threadId: id })));
    command("threadside.snooze", async (node?: { thread?: ThreadShell }) => {
      const until = await pickSnooze();
      if (until) await this.threadCommand(node, (id) => ({ type: "thread.snooze", threadId: id, snoozedUntil: until.toISOString() }));
    });
    command("threadside.copyThreadLink", async (node?: { thread?: ThreadShell }) => {
      const thread = node?.thread ?? this.activeThread();
      const environmentId = this.environment.descriptor?.environmentId;
      if (!thread || !environmentId) return;
      await vscode.env.clipboard.writeText(`https://app.t3.codes${threadPath(environmentId, thread.id)}`);
      vscode.window.setStatusBarMessage("$(check) Thread link copied", 2500);
    });
    command("threadside.openInBrowser", (node?: { thread?: ThreadShell }) => {
      const thread = node?.thread ?? this.activeThread();
      const environmentId = this.environment.descriptor?.environmentId;
      if (thread && environmentId) return vscode.env.openExternal(vscode.Uri.parse(`https://app.t3.codes${threadPath(environmentId, thread.id)}`));
    });
    command("threadside.openSettings", () => this.openChat({ path: "/settings/general" }));
    command("threadside.refresh", () => this.environment.connect());
    command("threadside.connect", () => this.connectFlow());
    command("threadside.disconnect", async () => {
      const ok = await vscode.window.showWarningMessage(
        "Disconnect Threadside from T3 Code and forget this editor's credential?",
        { modal: true },
        "Disconnect",
      );
      if (ok) await this.environment.forget();
    });
    command("threadside.takeOverShortcuts", () => takeOverShortcuts(this.context.globalState));
    command("threadside.restoreShortcuts", () => restoreShortcuts(this.context.globalState));
    command("threadside.showLog", () => log().show());
  }

  /**
   * ⌘I: like Cursor's chat pane. A docked chat on screen hides; a hidden one opens focused on the
   * composer. A chat tab hides by maximizing the file group, so the conversation keeps running and
   * comes back as it was.
   */
  private async toggleChat(): Promise<void> {
    const side = this.sideView;
    log().info(`Toggle chat: docked chat ${side ? (side.active ? "has focus" : side.visible ? "visible" : "hidden") : "not created"}.`);
    if (side?.active || (sideLocation() === "side" && !this.activePanel?.panel?.active)) {
      // A toggle, like Cursor's own pane: a docked chat on screen hides, wherever the focus is.
      if (side?.visible) return this.hideSideView();
      const chat = await this.openChat();
      chat.focusComposer();
      return;
    }
    const panel = this.activePanel?.panel ? this.activePanel : [...this.panels].find((candidate) => candidate.panel);
    const chatGroup = panel?.panel?.viewColumn;
    const separateGroup = chatGroup !== undefined && chatGroup !== this.fileColumn() && vscode.window.tabGroups.all.length > 1;
    if (panel?.panel?.active) {
      await this.focusFileGroup();
      if (separateGroup) {
        await vscode.commands.executeCommand("workbench.action.toggleMaximizeEditorGroup");
        this.chatHidden = true;
      }
      return;
    }
    if (panel && this.chatHidden && !panel.visible) {
      await this.focusFileGroup();
      await vscode.commands.executeCommand("workbench.action.toggleMaximizeEditorGroup");
    }
    this.chatHidden = false;
    const chat = await this.openChat();
    chat.focusComposer();
  }

  /**
   * Hides the docked chat wherever it sits (Side Bar, Secondary Side Bar or panel) and returns to the code.
   * Cursor has no command that only closes the Secondary Side Bar, and toggling it while the chat lives
   * elsewhere opens Cursor's own chat there, so the container that worked last time goes first.
   */
  private async hideSideView(): Promise<void> {
    this.userHidSideView = true;
    const side = this.sideView;
    const learned = this.context.globalState.get<string>(CLOSER_KEY);
    const closers = ["workbench.action.closeSidebar", "workbench.action.toggleAuxiliaryBar", "workbench.action.closePanel"];
    for (const closer of learned && closers.includes(learned) ? [learned, ...closers.filter((other) => other !== learned)] : closers) {
      await vscode.commands.executeCommand(closer);
      if (side && (await hidden(side))) {
        if (closer !== learned) await this.context.globalState.update(CLOSER_KEY, closer);
        log().info(`Hid the chat with ${closer}.`);
        break;
      }
      log().info(`${closer} did not hide the chat.`);
      // A toggle that did not hide the chat opened that bar instead: close it again.
      if (closer === "workbench.action.toggleAuxiliaryBar") await vscode.commands.executeCommand(closer);
    }
    await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
  }

  /**
   * Toggles the Secondary Side Bar to full width when the docked chat is shown there (the bar that last
   * hid it). Cursor has no such command for extension views (its own maximize brings its agent back).
   */
  private async maximizeSideBar(): Promise<boolean> {
    if (!this.sideView?.visible || this.context.globalState.get(CLOSER_KEY) !== "workbench.action.toggleAuxiliaryBar") return false;
    const available = new Set(await vscode.commands.getCommands(true));
    if (!available.has("workbench.action.toggleMaximizedAuxiliaryBar")) return false;
    await vscode.commands.executeCommand("workbench.action.toggleMaximizedAuxiliaryBar");
    return true;
  }

  /** Opens the docked chat's thread as an editor tab, for a wide view or to keep it beside another thread. */
  private async popOut(): Promise<void> {
    const path = (this.activePanel ?? this.sideView)?.path;
    await this.openChat({ path: path && path !== "/" ? path : undefined, newTab: true });
  }

  /**
   * ⌘N in the chat and ⌘' anywhere. T3 Code's own new thread keeps the open thread's project; from the
   * editor, a file in another repository wins, as in Cursor, so the draft starts in the code you are in.
   */
  private async newThread(): Promise<void> {
    const fromChat = this.activePanel?.active === true;
    const target = fromChat ? undefined : await this.ensureWorkspaceProject();
    const chat = await this.openChat();
    const currentId = chat.threadId ? this.environment.shell.threads.get(chat.threadId)?.projectId : undefined;
    const project = target ?? (currentId ? this.environment.shell.projects.get(currentId) : undefined) ?? this.workspaceProject();
    // T3 Code's new thread opens its project picker; answering it keeps the draft in the right repository.
    this.runT3Shortcut(chat, "chat.new", project?.title);
  }

  /** Looks for a newer T3 Code on the server's channel and offers it once per version. */
  private async checkForUpdate(): Promise<void> {
    const descriptor = this.environment.descriptor;
    if (!descriptor || !config().get("checkForUpdates", true)) return;
    try {
      this.availableUpdate = newerRelease(descriptor.serverVersion, await this.releases.fetch());
    } catch (error) {
      log().warn(`Could not check for T3 Code updates: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    this.updateStatus();
    const offered = "threadside.updateOffered";
    if (!this.availableUpdate || this.context.globalState.get(offered) === this.availableUpdate) return;
    await this.context.globalState.update(offered, this.availableUpdate);
    const choice = await vscode.window.showInformationMessage(
      `T3 Code ${this.availableUpdate} is available. ${descriptor.label} runs ${descriptor.serverVersion}.`,
      "Update",
      "Later",
    );
    if (choice === "Update") await vscode.commands.executeCommand("threadside.updateServer");
  }

  /**
   * Updates the connected server the way T3 Code's own update button does: the server installs the
   * build and restarts (through its desktop app when one runs it), the chat reconnects and, seeing a
   * new version, loads the new UI.
   */
  private async updateServer(): Promise<void> {
    const descriptor = this.environment.descriptor;
    const target = this.availableUpdate;
    if (!descriptor) throw new Error("Not connected to T3 Code.");
    if (!target) {
      void vscode.window.showInformationMessage(`T3 Code ${descriptor.serverVersion} on ${descriptor.label} is up to date.`);
      return;
    }
    if (!canSelfUpdate(descriptor)) {
      const channel = target.includes("-nightly.") ? " --channel nightly" : "";
      void vscode.window.showWarningMessage(`${descriptor.label} cannot update itself. Run \`t3 update${channel} --yes\` there, then restart T3 Code.`);
      return;
    }
    const running = [...this.environment.shell.threads.values()].filter(isRunning).length;
    const continues = descriptor.capabilities?.serverUpdateThreadContinuation === true;
    const detail = running && !continues ? `${running} ${running === 1 ? "thread is" : "threads are"} working and will be interrupted.` : "The chat reconnects on its own.";
    const answer = await vscode.window.showWarningMessage(`Update ${descriptor.label} to T3 Code ${target}? T3 Code restarts.`, { modal: true, detail }, "Update");
    if (answer !== "Update") return;
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Updating T3 Code to ${target}` }, async (progress) => {
      let result: { method?: string; desktopUpdateToken?: string } | undefined;
      await this.environment
        .stream("server.updateServerWithProgress", { targetVersion: target, ...(continues ? { continueRunningThreads: true } : {}) }, (values) => {
          for (const event of values as Array<{ type?: string; stage?: string; result?: typeof result }>) {
            if (event.type === "progress") progress.report({ message: event.stage === "downloading" ? "Downloading…" : "Installing…" });
            if (event.type === "complete") result = event.result;
          }
        })
        .catch((error: Error) => {
          // Sessions paired before 0.3.5 lack the scope; a local session is reissued with it on connect.
          if (!error.message.includes("environment:maintain")) throw error;
          throw new Error(`This editor's session on ${descriptor.label} cannot update T3 Code. Run “T3: Connect to T3 Code…” to get a new one, then update again.`);
        });
      progress.report({ message: "Restarting…" });
      // The desktop app relaunches into the new build once told to; the connection drops on the way.
      if (result?.method === "desktop-app" && result.desktopUpdateToken) {
        await this.environment.call("server.commitDesktopUpdate", { requestId: result.desktopUpdateToken }).catch(() => undefined);
      }
    });
    this.availableUpdate = undefined;
    this.updateStatus();
  }

  /** Starts a draft in this window's project; a window with no T3 project keeps T3 Code's start page. */
  private async startDraft(chat: ChatPanel): Promise<void> {
    await this.shellReady();
    const project = await this.ensureWorkspaceProject();
    if (project) this.runT3Shortcut(chat, "chat.new", project.title);
  }

  /** A restored thread stays only while it belongs to this window's code; otherwise a draft starts there. */
  private async keepThreadOrStartDraft(chat: ChatPanel, path: string): Promise<void> {
    await this.shellReady();
    const thread = this.environment.shell.threads.get(threadIdFromPath(path) ?? "");
    const scope = this.scopeProjects();
    const belongs = scope ? thread !== undefined && scope.has(thread.projectId) : thread !== undefined && !repositoryFolder();
    if (!belongs && chat.path === path) await this.startDraft(chat);
  }

  /** Resolves once the first project and thread list has arrived (the chat can be ready before it). */
  private async shellReady(): Promise<void> {
    const shell = this.environment.shell;
    if (shell.synchronized || shell.projects.size) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, 10_000);
      const subscription = shell.onDidChange(() => shell.projects.size && done());
      function done() {
        clearTimeout(timer);
        subscription.dispose();
        resolve();
      }
    });
  }

  /**
   * This window's T3 project. A repository folder T3 Code does not know yet becomes a project, as
   * T3 Code's own "Add project" does, so the chat never starts in another repository.
   */
  private async ensureWorkspaceProject(): Promise<ProjectShell | undefined> {
    const own = this.workspaceProject(false);
    const folder = own ? undefined : repositoryFolder();
    if (!folder || !config().get("createProjectForFolder", true) || this.environment.status.kind !== "connected") return own ?? this.workspaceProject();
    const shell = this.environment.shell;
    const created = new Promise<ProjectShell | undefined>((resolve) => {
      const timer = setTimeout(() => done(undefined), 5_000);
      const subscription = shell.onDidChange(() => {
        const project = shell.projectAt(folder);
        if (project) done(project);
      });
      function done(project: ProjectShell | undefined) {
        clearTimeout(timer);
        subscription.dispose();
        resolve(project);
      }
    });
    try {
      // T3 Code creates projects through its own mutation, not the orchestration command stream.
      await this.environment.call("projects.mutate", {
        type: "project.create",
        commandId: crypto.randomUUID(),
        projectId: crypto.randomUUID(),
        title: basename(folder),
        workspaceRoot: folder,
        createWorkspaceRootIfMissing: false,
      });
      log().info(`Added ${basename(folder)} to T3 Code as a project.`);
    } catch (error) {
      log().warn(`Could not add ${basename(folder)} to T3 Code: ${redact(error instanceof Error ? error.message : String(error))}`);
      return this.workspaceProject();
    }
    return (await created) ?? this.workspaceProject();
  }

  /** Runs a T3 Code shortcut in the chat; `pick` answers the picker it opens, such as the project list. */
  private runT3Shortcut(chat: ChatPanel, t3Command: string, pick?: string): void {
    const chord = t3Shortcut(t3Command, resolveT3Home(config().get("t3Home", "")));
    if (chord) chat.post({ type: "shortcut", chord, pick });
  }

  /**
   * The T3 project for a new thread: the one whose folder is this window's folder, then the active
   * file's, then the project holding a workspace folder, then (unless `orOpenThread` is false) the open thread's. A window on a parent
   * folder stays in its own project even while a file of a nested project is open.
   */
  private workspaceProject(orOpenThread = true): ProjectShell | undefined {
    const shell = this.environment.shell;
    const folders = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
    const file = (vscode.window.activeTextEditor ?? this.lastTextEditor)?.document.uri;
    const thread = this.activeThread();
    const candidates = [
      ...folders.map((folder) => shell.projectAt(folder)),
      file?.scheme === "file" || file?.scheme === "vscode-remote" ? shell.projectForPath(file.fsPath) : undefined,
      ...folders.map((folder) => shell.projectForPath(folder)),
      orOpenThread && thread ? shell.projects.get(thread.projectId) : undefined,
    ];
    return candidates.find((project) => project !== undefined);
  }

  private async openThread(threadId: string, newTab = false): Promise<void> {
    const environmentId = this.environment.descriptor?.environmentId;
    if (!environmentId) throw new Error("Not connected to T3 Code.");
    await this.openChat({ path: threadPath(environmentId, threadId), newTab });
  }

  private async threadCommand(node: { thread?: ThreadShell } | undefined, build: (id: string) => Record<string, unknown>): Promise<void> {
    const thread = node?.thread ?? this.activeThread();
    if (!thread) {
      void vscode.window.showInformationMessage("Open a thread first, or use the thread list.");
      return;
    }
    await this.environment.dispatch(build(thread.id));
  }

  private async addSelection(): Promise<void> {
    const editor = vscode.window.activeTextEditor ?? this.lastTextEditor;
    if (!editor) return;
    const path = this.mentionPath(editor.document.uri.fsPath);
    const mentions = editor.selections
      .filter((selection) => !selection.isEmpty)
      .map((selection) => {
        const endLine = selection.end.character === 0 && selection.end.line > selection.start.line ? selection.end.line : selection.end.line + 1;
        return mentionFor(path, selection.start.line + 1, endLine);
      });
    const chat = await this.openChat();
    chat.insertMentions(mentions.length ? mentions : [mentionFor(path)]);
  }

  /**
   * ⇧⌘H: every thread, grouped the way T3 Code's list groups them (pinned, active, snoozed, settled).
   * ↵ opens a thread in the chat, ⌘T or the tab button opens it in a new editor tab, and the check
   * button settles it (or brings a settled one back) without closing the list.
   */
  private async searchThreads(): Promise<void> {
    const shell = this.environment.shell;
    const scope = this.scopeProjects();
    const open = (thread: ThreadShell | undefined, newTab: boolean) => {
      log().debug(`Thread picker: open ${thread ? "a thread" : "nothing"}${newTab ? " in a new tab" : ""}.`);
      if (!thread) return;
      pick.hide();
      void this.openThread(thread.id, newTab);
    };
    const pick = vscode.window.createQuickPick<ThreadItem>();
    pick.title = "T3 Threads";
    pick.placeholder = "Search threads by title, project or branch  ·  ↵ open  ·  ⌘T open in new tab";
    pick.matchOnDescription = true;
    pick.matchOnDetail = true;
    // Matches keep the list's last-activity order instead of being ranked by how well the title matches.
    // `sortByLabel` is typed only in a proposed API, but the editor honours it at runtime.
    (pick as vscode.QuickPick<ThreadItem> & { sortByLabel: boolean }).sortByLabel = false;
    let searching = false;
    const refresh = () => {
      const active = pick.activeItems[0]?.thread?.id;
      pick.items = threadPickerItems([...shell.threads.values()], scope, (id) => shell.projects.get(id)?.title, searching);
      const again = active && pick.items.find((item) => item.thread?.id === active);
      if (again) pick.activeItems = [again];
    };
    refresh();
    const subscription = shell.onDidChange(refresh);
    pick.onDidChangeValue((value) => {
      if (Boolean(value) === searching) return;
      searching = Boolean(value);
      refresh();
    });
    pick.onDidTriggerItemButton(({ item, button }) => {
      const thread = item.thread;
      if (!thread) return;
      if (isOpenInTab(button)) return open(thread, true);
      const settled = isSettled(thread);
      void this.environment
        .dispatch(settled ? { type: "thread.unsettle", threadId: thread.id, reason: "user" } : { type: "thread.settle", threadId: thread.id })
        .then(
          () => vscode.window.setStatusBarMessage(`$(check) ${settled ? "Unsettled" : "Settled"} “${thread.title}”`, 2500),
          (error: unknown) => void vscode.window.showErrorMessage(`T3: ${error instanceof Error ? error.message : String(error)}`),
        );
    });
    pick.onDidAccept(() => open(pick.selectedItems[0]?.thread, false));
    pick.onDidHide(() => {
      subscription.dispose();
      this.threadPicker = undefined;
      void vscode.commands.executeCommand("setContext", "threadside.threadPickerOpen", false);
      pick.dispose();
    });
    this.threadPicker = { openActiveInTab: () => open(pick.activeItems[0]?.thread, true) };
    void vscode.commands.executeCommand("setContext", "threadside.threadPickerOpen", true);
    pick.show();
  }

  private async connectFlow(): Promise<void> {
    type Item = vscode.QuickPickItem & { action: "local" | "link" | "url" };
    const choice = await vscode.window.showQuickPick<Item>(
      [
        { label: "$(vm) This machine", detail: "Use the T3 Code server running where this workspace lives. No setup needed.", action: "local" },
        { label: "$(link) Pairing link", detail: "Paste a link from T3 Code → Settings → Sharing & access, or from `t3 pair`.", action: "link" },
        { label: "$(globe) Server address", detail: "Set the server URL (Tailscale HTTPS or T3 Connect), then pair.", action: "url" },
      ],
      { title: "Connect to T3 Code" },
    );
    if (!choice) return;
    if (choice.action === "local") {
      await config().update("serverUrl", "", vscode.ConfigurationTarget.Global);
      await this.environment.connect();
      return;
    }
    if (choice.action === "url") {
      const url = await vscode.window.showInputBox({ title: "T3 Code server address", placeHolder: "https://my-mac.tailnet.ts.net", ignoreFocusOut: true });
      if (!url) return;
      await config().update("serverUrl", url.trim(), vscode.ConfigurationTarget.Global);
    }
    const link = await vscode.window.showInputBox({
      title: "Pairing link",
      placeHolder: "https://host/pair#token=…",
      prompt: "Pairing links work once. Treat them like a password.",
      password: true,
      ignoreFocusOut: true,
    });
    if (!link) return;
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Pairing with T3 Code…" }, () =>
      this.environment.pair(link),
    );
  }

  private async handleUri(uri: vscode.Uri): Promise<void> {
    const params = new URLSearchParams(uri.query);
    if (uri.path === "/pair") {
      const link = params.get("link") ?? params.get("url");
      if (!link) return;
      // A link from a web page or chat must not silently point this editor at someone else's server,
      // so the dialog names the server the link would actually pair with.
      let host: string;
      try {
        host = new URL(parsePairingInput(link).httpBaseUrl).host;
      } catch (error) {
        void vscode.window.showErrorMessage(`T3: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      const ok = await vscode.window.showWarningMessage(
        `Pair this editor with the T3 Code server at ${host}?`,
        { modal: true, detail: "Only continue if you just created this pairing link on your own machine." },
        "Pair",
      );
      if (ok === "Pair") await this.environment.pair(link);
      return;
    }
    if (uri.path === "/thread") {
      const id = params.get("id");
      if (id) await this.openThread(id);
    }
  }

  // ---------------------------------------------------------------- scope, status, notifications

  /** Projects that belong to this window's folders; undefined means every project. */
  private scopeProjects(): ReadonlySet<string> | undefined {
    if (this.scope === "all") return undefined;
    const folders = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
    if (!folders.length) return undefined;
    const ids = new Set<string>();
    for (const project of this.environment.shell.projects.values()) {
      // A folder that holds several projects (such as ~/Development) shows all of them.
      if (folders.some((folder) => isInside(folder, project.workspaceRoot))) ids.add(project.id);
    }
    // A project folder, a folder inside one, or a thread's worktree.
    for (const folder of folders) {
      const project = this.environment.shell.projectForPath(folder);
      if (project) ids.add(project.id);
    }
    return ids.size ? ids : undefined;
  }

  private updateStatus(): void {
    const status = this.environment.status;
    const item = this.statusItem;
    if (status.kind === "connecting" || status.kind === "idle") {
      item.text = "$(sync~spin) T3";
      item.tooltip = "Connecting to T3 Code…";
    } else if (status.kind === "needs-pairing") {
      item.text = "$(plug) T3";
      item.tooltip = status.reason;
      item.command = "threadside.connect";
    } else if (status.kind === "error") {
      item.text = "$(warning) T3";
      item.tooltip = `${status.message}\n\nClick to reconnect.`;
      item.command = "threadside.refresh";
    } else {
      item.command = "threadside.toggleChat";
      const scope = this.scopeProjects();
      const threads = [...this.environment.shell.threads.values()].filter((thread) => !scope || scope.has(thread.projectId));
      const running = threads.filter(isRunning).length;
      const waiting = threads.filter((thread) => Boolean(thread.pendingRuntimeRequest)).length;
      const active = this.activeThread();
      const parts = ["$(comment-discussion) T3"];
      if (waiting) parts.push(`$(bell-dot) ${waiting}`);
      if (running) parts.push(`$(loading~spin) ${running}`);
      const reset = active && limitResetAt(active);
      if (reset) parts.push(`$(watch) ${reset.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`);
      if (this.availableUpdate) parts.push("$(arrow-circle-up)");
      item.text = parts.join(" ");
      const md = new vscode.MarkdownString(undefined, true);
      md.appendMarkdown(`**${status.descriptor.label}** · T3 Code ${status.descriptor.serverVersion}\n\n`);
      if (active) md.appendMarkdown(`Thread: ${active.title} · ${statusLabel(active)}\n\n`);
      md.appendMarkdown(`${running} working · ${waiting} waiting for you\n\n[Search threads](command:threadside.searchThreads) · [New thread](command:threadside.newThread)`);
      if (this.availableUpdate) md.appendMarkdown(`\n\n$(arrow-circle-up) T3 Code ${this.availableUpdate} is available · [Update](command:threadside.updateServer)`);
      md.isTrusted = { enabledCommands: ["threadside.searchThreads", "threadside.newThread", "threadside.updateServer"] };
      item.tooltip = md;
    }
    item.show();
  }

  /**
   * A notification T3 Code raised in a chat (its own "Thread notifications"), shown natively. Opening
   * it shows that chat and fires the notification's click there, so T3 Code opens the thread itself.
   */
  private showT3Notification(panel: ChatPanel, message: BridgeMessage): void {
    const id = typeof message.id === "number" ? message.id : undefined;
    const title = typeof message.title === "string" ? message.title : "";
    const body = typeof message.body === "string" ? message.body : "";
    if (id === undefined || !title) return;
    // Like the thread list beside it, a window notifies about the projects its list is filtered to.
    const thread = this.threadForTag(typeof message.tag === "string" ? message.tag : "");
    if (thread && !this.inT3Scope(thread, scopeKeysOf(message.scopeKeys))) {
      log().info(`T3 notification "${title}" for a thread outside this window's thread-list filter; not shown.`);
      return;
    }
    if (thread && this.watching(thread.id)) {
      log().info(`T3 notification "${title}" for the thread on screen; not shown.`);
      return;
    }
    log().info(`T3 notification "${title}"${thread ? "" : " (thread not in the list)"}; shown.`);
    const key = `${String(message.tag ?? "")}|${title}|${body}`;
    const now = Date.now();
    for (const [shown, at] of this.shownNotifications) if (now - at > 10_000) this.shownNotifications.delete(shown);
    if (this.shownNotifications.has(key)) return;
    this.shownNotifications.set(key, now);
    void vscode.window.showInformationMessage(`T3: ${title}${body ? ` — ${body}` : ""}`, "Open thread").then((action) => {
      if (action !== "Open thread") return;
      panel.reveal(false);
      panel.post({ type: "notificationClick", id });
    });
  }

  /** Whether a chat on screen in this focused window shows the thread, so a notification would only repeat it. */
  private watching(threadId: string): boolean {
    return vscode.window.state.focused && [...this.panels].some((panel) => panel.threadId === threadId && panel.visible);
  }

  /** The thread a T3 Code notification is about, from its tag. */
  private threadForTag(tag: string): ThreadShell | undefined {
    const environmentId = this.environment.descriptor?.environmentId;
    if (!environmentId || !tag) return undefined;
    for (const thread of this.environment.shell.threads.values()) if (notificationTag(environmentId, thread.id) === tag) return thread;
    return undefined;
  }

  /** Whether a thread's project is in T3 Code's thread-list filter (no filter means every project). */
  private inT3Scope(thread: ThreadShell, scopeKeys: string[] | undefined): boolean {
    const environmentId = this.environment.descriptor?.environmentId;
    const project = this.environment.shell.projects.get(thread.projectId);
    if (!scopeKeys?.length || !environmentId || !project) return true;
    return scopeKeys.includes(sidebarProjectKey(project, environmentId));
  }

  private notify(ids: ReadonlySet<string>): void {
    const mode = config().get<"attention" | "all" | "off">("notifications", "attention");
    // T3 Code notifies from the chat while its own setting is on; the same event once is enough.
    const t3Notifies = this.t3NotificationMode === "notifications" || this.t3NotificationMode === "notifications-and-sound";
    const scope = this.scopeProjects();
    const threads = this.environment.shell.threads;
    if (ids.size === 0) {
      this.lastSeen.clear();
      for (const thread of threads.values()) this.lastSeen.set(thread.id, thread);
      return;
    }
    for (const id of ids) {
      const thread = threads.get(id);
      const before = this.lastSeen.get(id);
      if (!thread) {
        this.lastSeen.delete(id);
        continue;
      }
      this.lastSeen.set(id, thread);
      const outOfScope = this.t3ScopeKeys ? !this.inT3Scope(thread, this.t3ScopeKeys) : scope !== undefined && !scope.has(thread.projectId);
      if (mode === "off" || t3Notifies || !before || outOfScope) continue;
      if (this.watching(id)) continue;
      let message: string | undefined;
      let severity: "info" | "warning" | "error" = "info";
      if (thread.pendingRuntimeRequest && !before.pendingRuntimeRequest) {
        message = `${thread.title} is waiting for you.`;
        severity = "warning";
      } else if (thread.status === "failed" && before.status !== "failed") {
        message = `${thread.title} failed${thread.lastError ? `: ${thread.lastError.slice(0, 120)}` : "."}`;
        severity = "error";
      } else if (limitResetAt(thread) && !limitResetAt(before)) {
        message = `${thread.title} hit a usage limit. ${statusLabel(thread)}.`;
        severity = "warning";
      } else if (mode === "all" && isRunning(before) && !isRunning(thread)) {
        message = `${thread.title}: ${statusLabel(thread)}.`;
      }
      if (!message) continue;
      const show =
        severity === "error" ? vscode.window.showErrorMessage : severity === "warning" ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
      void show(`T3: ${message}`, "Open").then((action) => {
        if (action === "Open") void this.openThread(id);
      });
    }
  }

  dispose(): void {
    for (const panel of this.panels) panel.panel?.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }
}

/**
 * The window's first folder that is a repository's own root, on the machine running the workspace. A
 * linked worktree (whose `.git` is a file) is left to the project of its repository.
 */
function repositoryFolder(): string | undefined {
  return (vscode.workspace.workspaceFolders ?? [])
    .filter((folder) => folder.uri.scheme === "file" || folder.uri.scheme === "vscode-remote")
    .map((folder) => folder.uri.fsPath)
    .find((folder) => existsSync(join(folder, ".git", "HEAD")));
}

/**
 * Waits for the docked chat to report it is hidden. In a Remote-SSH window the report crosses the
 * connection, so a closer that worked can take several hundred milliseconds to show it.
 */
async function hidden(chat: ChatPanel): Promise<boolean> {
  for (let attempt = 0; attempt < 40 && chat.visible; attempt++) await new Promise((resolve) => setTimeout(resolve, 25));
  return !chat.visible;
}

/** T3 Code's thread-list filter as the chat reports it: a list of project keys, empty for every project. */
function scopeKeysOf(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((key): key is string => typeof key === "string") : undefined;
}

function isChatTab(tab: vscode.Tab): boolean {
  return tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith(VIEW_TYPE);
}

function isDiskFile(uri: vscode.Uri): boolean {
  return uri.scheme === "file" || uri.scheme === "vscode-remote";
}

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("threadside");
}

/** Where the chat opens: docked in a side bar (the default), an editor group beside the code, or the active group. */
function sideLocation(): "side" | "beside" | "active" {
  const value = config().get<string>("chatLocation", "side");
  return value === "beside" || value === "active" ? value : "side";
}

async function pickSnooze(): Promise<Date | undefined> {
  const at = (days: number, hour: number) => {
    const date = new Date();
    date.setDate(date.getDate() + days);
    date.setHours(hour, 0, 0, 0);
    return date;
  };
  const nextMonday = () => {
    const date = at(1, 9);
    while (date.getDay() !== 1) date.setDate(date.getDate() + 1);
    return date;
  };
  type Item = vscode.QuickPickItem & { at?: () => Date };
  const fmt = (date: Date) => date.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });
  const options: Item[] = [
    { label: "1 hour", at: () => new Date(Date.now() + 3_600_000) },
    { label: "3 hours", at: () => new Date(Date.now() + 3 * 3_600_000) },
    ...(new Date().getHours() < 18 ? [{ label: "This evening", description: fmt(at(0, 19)), at: () => at(0, 19) }] : []),
    { label: "Tomorrow", description: fmt(at(1, 9)), at: () => at(1, 9) },
    { label: "Next week", description: fmt(nextMonday()), at: nextMonday },
    { label: "Custom…" },
  ];
  const choice = await vscode.window.showQuickPick(options, { title: "Snooze until" });
  if (!choice) return undefined;
  if (choice.at) return choice.at();
  const input = await vscode.window.showInputBox({
    title: "Snooze for",
    prompt: "A duration such as 45m, 2h or 3d",
    validateInput: (value) => (/^\s*\d+\s*[mhd]\s*$/i.test(value) ? undefined : "Use a number followed by m, h or d."),
  });
  if (!input) return undefined;
  const amount = Number.parseInt(input, 10);
  const unit = input.trim().slice(-1).toLowerCase();
  return new Date(Date.now() + amount * (unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000));
}
