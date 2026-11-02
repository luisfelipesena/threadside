import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { relative as relativePath } from "node:path";
import * as vscode from "vscode";
import { resolveT3Home } from "./connection/discovery";
import { Environment } from "./connection/environment";
import { isRunning, limitResetAt, sectionOf, type ThreadShell } from "./connection/shell";
import { t3Shortcut } from "./connection/t3Keys";
import { restoreShortcuts, takeOverShortcuts } from "./keybindings/takeover";
import { log, redact } from "./log";
import { mentionFor, parseFileHref } from "./native/fileLinks";
import { reviewChanges } from "./native/review";
import { relative, statusLabel, ThreadsTree } from "./native/threadsTree";
import { AuthProxy } from "./proxy/authProxy";
import { threadIdFromPath, threadPath } from "./routes";
import { type BridgeMessage, ChatPanel, setExtensionUri, VIEW_TYPE } from "./webview/chatPanel";

const PORT_KEY = "threadside.proxyPort";

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
  private readonly tree: ThreadsTree;
  private readonly treeView: vscode.TreeView<unknown>;
  private readonly statusItem: vscode.StatusBarItem;
  private readonly panels = new Set<ChatPanel>();
  private activePanel: ChatPanel | undefined;
  private originPromise: Promise<string> | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly lastSeen = new Map<string, ThreadShell>();
  private scope: "workspace" | "all";
  /** The last text editor, so commands still find it after focus moves to the chat. */
  private lastTextEditor: vscode.TextEditor | undefined = vscode.window.activeTextEditor;
  /** Set when ⌘I hid the chat by maximizing the file group. */
  private chatHidden = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.environment = new Environment(context.secrets);
    this.proxy = new AuthProxy(vscode.Uri.joinPath(context.extensionUri, "dist", "bridge.js").fsPath);
    this.scope = config().get("threadScope", "workspace");
    this.tree = new ThreadsTree(this.environment, () => this.scopeProjects());
    this.treeView = vscode.window.createTreeView("threadside.threads", { treeDataProvider: this.tree as vscode.TreeDataProvider<unknown>, showCollapseAll: true });
    this.statusItem = vscode.window.createStatusBarItem("threadside.status", vscode.StatusBarAlignment.Right, 1000);
    this.statusItem.name = "T3 Code";
    this.statusItem.command = "threadside.toggleChat";
    this.disposables.push(this.environment, this.tree, this.treeView, this.statusItem, this.proxy);
  }

  async start(): Promise<void> {
    this.registerCommands();
    this.disposables.push(
      vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
        deserializeWebviewPanel: async (panel, state) => {
          this.adopt(new ChatPanel(panel, this.chatHost(), state as { path?: string } | undefined));
        },
      }),
      vscode.window.registerUriHandler({ handleUri: (uri) => this.handleUri(uri) }),
      this.environment.onDidChangeStatus((status) => {
        if (status.kind === "connected") {
          this.proxy.setTarget({ httpBaseUrl: status.httpBaseUrl, bearer: () => this.environment.bearer() });
          for (const panel of this.panels) void panel.render();
        }
        this.tree.refresh();
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
        if (event.affectsConfiguration("threadside")) this.tree.refresh();
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.tree.refresh()),
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
    await this.environment.connect();
    if (config().get("openChatOnStartup", false) && this.panels.size === 0) await this.openChat();
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
      const port = await this.proxy.start(this.context.globalState.get<number>(PORT_KEY));
      await this.context.globalState.update(PORT_KEY, port);
      const external = await vscode.env.asExternalUri(vscode.Uri.parse(`http://127.0.0.1:${port}`));
      const origin = new URL(external.toString(true)).origin;
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
    const existing = !options.newTab ? this.activePanel ?? [...this.panels][0] : undefined;
    if (existing) {
      if (options.path) existing.navigate(options.path);
      existing.reveal(options.preserveFocus);
      return existing;
    }
    const beside = config().get("chatLocation", "beside") === "beside";
    const groupsBefore = vscode.window.tabGroups.all.length;
    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      "T3",
      { viewColumn: beside ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active, preserveFocus: options.preserveFocus ?? false },
      { enableScripts: true, retainContextWhenHidden: true, enableFindWidget: false },
    );
    const chat = this.adopt(new ChatPanel(panel, this.chatHost(), { path: options.path ?? "/" }));
    // A fresh chat with no thread starts a draft in the repository this window is coding in.
    if (!options.path) chat.onFirstReady = () => this.runT3Shortcut(chat, "chat.new", this.workspaceProject()?.title);
    // Like Cursor's chat: a narrow column on the right that keeps file tabs out of it.
    if (beside && groupsBefore === 1 && vscode.window.tabGroups.all.length === 2) {
      await vscode.commands.executeCommand("vscode.setEditorLayout", { orientation: 0, groups: [{ size: 0.64 }, { size: 0.36 }] });
      await vscode.commands.executeCommand("workbench.action.lockEditorGroup");
    }
    return chat;
  }

  private onPanelChanged(): void {
    const active = [...this.panels].find((panel) => panel.panel.active);
    if (active) this.activePanel = active;
    const thread = this.activeThread();
    void vscode.commands.executeCommand("setContext", "threadside.activeHasWorktree", Boolean(thread && this.threadDir(thread)));
    this.updatePanelTitles();
    this.updateStatus();
  }

  private updatePanelTitles(): void {
    for (const panel of this.panels) {
      const id = panel.threadId;
      const thread = id ? this.environment.shell.threads.get(id) : undefined;
      const title = thread?.title ?? (panel.path.startsWith("/settings") ? "T3 Settings" : "T3");
      const label = thread && isRunning(thread) ? `${title}` : title;
      if (panel.panel.title !== label) panel.panel.title = label;
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
        void this.openFile(panel, String(message.href ?? ""), Boolean(message.beside));
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
      default:
        break;
    }
  }

  private async openFile(panel: ChatPanel, href: string, beside: boolean): Promise<void> {
    const threadId = threadIdFromPath(panel.path);
    const thread = threadId ? this.environment.shell.threads.get(threadId) : undefined;
    const base = thread ? this.threadDir(thread) : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const target = parseFileHref(href, base, homedir());
    if (!target) {
      log().info(`Not a file link: ${redact(href)}`);
      return;
    }
    if (!existsSync(target.path)) {
      void vscode.window.showWarningMessage(`${target.path} is not on this machine. Alt-click the link to preview it in T3 Code.`);
      return;
    }
    const uri = this.workspaceUri(target.path);
    const line = Math.max(0, (target.line ?? 1) - 1);
    const start = new vscode.Position(line, Math.max(0, (target.column ?? 1) - 1));
    const end = target.endLine ? new vscode.Position(Math.max(line, target.endLine - 1), Number.MAX_SAFE_INTEGER) : start;
    const document = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(document, {
      viewColumn: beside ? vscode.ViewColumn.Beside : this.fileColumn(),
      selection: new vscode.Range(start, end),
      preview: false,
    });
    editor.revealRange(new vscode.Range(start, end), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  /** The editor group for files: the first group that does not hold a chat tab. */
  private fileColumn(): vscode.ViewColumn {
    for (const group of vscode.window.tabGroups.all) {
      const holdsChat = group.tabs.some((tab) => tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith(VIEW_TYPE));
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
    const roots = [thread && this.threadDir(thread), ...(vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath)];
    for (const root of roots) {
      if (!root) continue;
      const rel = relativePath(root, path);
      if (rel && !rel.startsWith("..") && !rel.startsWith("/")) return rel;
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
    command("threadside.focusComposer", async () => (await this.openChat()).focusComposer());
    command("threadside.focusOrAddSelection", async () => {
      const editor = vscode.window.activeTextEditor;
      if (editor && !editor.selection.isEmpty) return vscode.commands.executeCommand("threadside.addSelection");
      const chat = await this.openChat();
      chat.focusComposer();
    });
    command("threadside.newThread", () => this.newThread());
    command("threadside.newThreadInTab", () => this.openChat({ newTab: true }));
    command("threadside.openThread", (threadId: string) => this.openThread(threadId));
    command("threadside.openThreadInNewTab", (node?: { thread?: ThreadShell }) => {
      const id = node?.thread?.id ?? this.activeThread()?.id;
      if (id) return this.openThread(id, true);
    });
    command("threadside.searchThreads", () => this.searchThreads());
    command("threadside.addSelection", () => this.addSelection());
    command("threadside.addFile", async (uri?: vscode.Uri) => {
      const target = uri ?? (vscode.window.activeTextEditor ?? this.lastTextEditor)?.document.uri;
      if (!target) return;
      const chat = await this.openChat();
      chat.insertMentions([mentionFor(this.mentionPath(target.fsPath))]);
    });
    command("threadside.toggleMaximize", async () => {
      if (!this.activePanel?.panel.active) await this.openChat();
      await vscode.commands.executeCommand("workbench.action.toggleMaximizeEditorGroup");
    });
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
    command("threadside.toggleScope", async () => {
      this.scope = this.scope === "workspace" ? "all" : "workspace";
      await config().update("threadScope", this.scope, vscode.ConfigurationTarget.Global);
      this.tree.refresh();
      vscode.window.setStatusBarMessage(this.scope === "all" ? "T3: showing every project" : "T3: showing this workspace", 2500);
    });
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
   * ⌘I: like Cursor's chat pane. Opens the chat focused on the composer; from the chat, hides it by
   * maximizing the file group, so the conversation keeps running and comes back as it was.
   */
  private async toggleChat(): Promise<void> {
    const panel = this.activePanel ?? [...this.panels][0];
    const chatGroup = panel?.panel.viewColumn;
    const separateGroup = chatGroup !== undefined && chatGroup !== this.fileColumn() && vscode.window.tabGroups.all.length > 1;
    if (panel?.panel.active) {
      await this.focusFileGroup();
      if (separateGroup) {
        await vscode.commands.executeCommand("workbench.action.toggleMaximizeEditorGroup");
        this.chatHidden = true;
      }
      return;
    }
    if (panel && this.chatHidden && !panel.panel.visible) {
      await this.focusFileGroup();
      await vscode.commands.executeCommand("workbench.action.toggleMaximizeEditorGroup");
    }
    this.chatHidden = false;
    const chat = await this.openChat();
    chat.focusComposer();
  }

  /**
   * ⌘N in the chat and ⌘' anywhere. T3 Code's own new thread keeps the open thread's project; from the
   * editor, a file in another repository wins, as in Cursor, so the draft starts in the code you are in.
   */
  private async newThread(): Promise<void> {
    const fromChat = this.activePanel?.panel.active === true;
    const target = fromChat ? undefined : this.workspaceProject();
    const chat = await this.openChat();
    const currentId = chat.threadId ? this.environment.shell.threads.get(chat.threadId)?.projectId : undefined;
    const project = target ?? (currentId ? this.environment.shell.projects.get(currentId) : undefined) ?? this.workspaceProject();
    // T3 Code's new thread opens its project picker; answering it keeps the draft in the right repository.
    this.runT3Shortcut(chat, "chat.new", project?.title);
  }

  /** Runs a T3 Code shortcut in the chat; `pick` answers the picker it opens, such as the project list. */
  private runT3Shortcut(chat: ChatPanel, t3Command: string, pick?: string): void {
    const chord = t3Shortcut(t3Command, resolveT3Home(config().get("t3Home", "")));
    if (chord) chat.post({ type: "shortcut", chord, pick });
  }

  /** The T3 project for a new thread: the active file's, a workspace folder's, then the open thread's. */
  private workspaceProject() {
    const shell = this.environment.shell;
    const file = (vscode.window.activeTextEditor ?? this.lastTextEditor)?.document.uri;
    const thread = this.activeThread();
    // Like Cursor's new chat: the project you are coding in first, then the open thread's project.
    const candidates = [
      file?.scheme === "file" || file?.scheme === "vscode-remote" ? shell.projectForPath(file.fsPath) : undefined,
      ...(vscode.workspace.workspaceFolders ?? []).map((folder) => shell.projectForPath(folder.uri.fsPath)),
      thread ? shell.projects.get(thread.projectId) : undefined,
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

  private async searchThreads(): Promise<void> {
    const projects = this.environment.shell.projects;
    const scope = this.scopeProjects();
    type Item = vscode.QuickPickItem & { thread?: ThreadShell };
    const sectionIcon: Record<string, string> = { pinned: "$(pinned)", active: "$(comment-discussion)", snoozed: "$(bell-slash)", settled: "$(check)" };
    const toItem = (thread: ThreadShell): Item => ({
      label: `${isRunning(thread) ? "$(loading~spin)" : sectionIcon[sectionOf(thread)]} ${thread.title || "Untitled thread"}`,
      description: [projects.get(thread.projectId)?.title, thread.branch].filter(Boolean).join(" · "),
      detail: `${statusLabel(thread)} · ${relative(thread.updatedAt)} ago`,
      thread,
      buttons: [{ iconPath: new vscode.ThemeIcon("link-external"), tooltip: "Open in New Tab" }],
    });
    const threads = [...this.environment.shell.threads.values()].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    const inScope = scope ? threads.filter((thread) => scope.has(thread.projectId)) : threads;
    const others = scope ? threads.filter((thread) => !scope.has(thread.projectId)) : [];
    const items: Item[] = [
      ...inScope.slice(0, 400).map(toItem),
      ...(others.length ? [{ label: "Other projects", kind: vscode.QuickPickItemKind.Separator } as Item, ...others.slice(0, 400).map(toItem)] : []),
    ];
    const pick = vscode.window.createQuickPick<Item>();
    pick.title = "T3 Threads";
    pick.placeholder = "Search threads by title, project or branch";
    pick.matchOnDescription = true;
    pick.matchOnDetail = true;
    pick.items = items;
    pick.onDidTriggerItemButton(({ item }) => {
      if (item.thread) void this.openThread(item.thread.id, true);
      pick.hide();
    });
    pick.onDidAccept(() => {
      const thread = pick.selectedItems[0]?.thread;
      if (thread) void this.openThread(thread.id);
      pick.hide();
    });
    pick.onDidHide(() => pick.dispose());
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
      // A link from a web page or chat must not silently point this editor at someone else's server.
      const host = new URL(link.includes("://") ? link : `https://${link}`).host;
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
    const folders = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath.replace(/\/+$/, ""));
    if (!folders.length) return undefined;
    const ids = new Set<string>();
    for (const project of this.environment.shell.projects.values()) {
      const root = project.workspaceRoot.replace(/\/+$/, "");
      // A folder that holds several projects (such as ~/Development) shows all of them.
      if (folders.some((folder) => root.startsWith(`${folder}/`))) ids.add(project.id);
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
      item.text = parts.join(" ");
      const md = new vscode.MarkdownString(undefined, true);
      md.appendMarkdown(`**${status.descriptor.label}** · T3 Code ${status.descriptor.serverVersion}\n\n`);
      if (active) md.appendMarkdown(`Thread: ${active.title} · ${statusLabel(active)}\n\n`);
      md.appendMarkdown(`${running} working · ${waiting} waiting for you\n\n[Search threads](command:threadside.searchThreads) · [New thread](command:threadside.newThread)`);
      md.isTrusted = { enabledCommands: ["threadside.searchThreads", "threadside.newThread"] };
      item.tooltip = md;
    }
    item.show();
  }

  private notify(ids: ReadonlySet<string>): void {
    const mode = config().get<"attention" | "all" | "off">("notifications", "attention");
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
      if (mode === "off" || !before || (scope && !scope.has(thread.projectId))) continue;
      const visible = [...this.panels].some((panel) => panel.threadId === id && panel.panel.visible && vscode.window.state.focused);
      if (visible) continue;
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
    for (const panel of this.panels) panel.panel.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }
}

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("threadside");
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
