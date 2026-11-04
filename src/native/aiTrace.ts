import { stat } from "node:fs/promises";
import { basename } from "node:path";
import * as vscode from "vscode";
import type { Environment } from "../connection/environment";
import type { ThreadKey } from "../routes";
import type { EditorSnapshot } from "./ideContext";
import { traceCheckout, sameCheckout, type TraceCheckout } from "./traceCheckout";
import { activityPath, failedItem, patchSpans, publicInsight, readSpans, record, resolveTracePath, traceItem, type TraceItem } from "./traceActivity";

export interface TraceView {
  enabled: boolean;
  paused: boolean;
  available: boolean;
  label: string;
  detail: string;
  insight: string;
  checkout: string;
  branchDetail: string;
}

export interface TraceHost {
  environment: Environment;
  selected(): { key?: ThreadKey; visible: boolean };
  editor(): vscode.TextEditor | undefined;
  capture(editor: vscode.TextEditor): EditorSnapshot | undefined;
  toUri(path: string): vscode.Uri;
  changed(): void;
}

const same = (a: ThreadKey | undefined, b: ThreadKey | undefined) => !!a && !!b && a.environmentId === b.environmentId && a.threadId === b.threadId;

/** Window-owned, opt-in observer. It never edits files or sends messages to the agent. */
export class AITrace implements vscode.Disposable {
  private pin: ThreadKey | undefined;
  private title = "";
  private root: string | undefined;
  private projectId: string | undefined;
  private checkout: TraceCheckout | undefined;
  private humanCheckout: TraceCheckout | undefined;
  private checkoutReady: Promise<void> = Promise.resolve();
  private checkoutInvalid = false;
  private checkoutBound = false;
  private idePath: string | undefined;
  private epoch = 0;
  private sequence = -1;
  private runId: string | undefined;
  private paused = false;
  private pauseReason = "";
  private suspended = false;
  private disconnected = false;
  private detail = "";
  private insight = "";
  private subscription: { cancel(): void } | undefined;
  private pending: TraceItem | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private fade: ReturnType<typeof setTimeout> | undefined;
  private busy = false;
  private lastOpened = 0;
  private opening = false;
  private programmaticScrollUntil = 0;
  private human: vscode.TextEditor | undefined;
  private savedContext: EditorSnapshot | undefined;
  private group: vscode.TabGroup | undefined;
  private shown: vscode.TextEditor | undefined;
  private readonly autoFiles = new Set<string>();
  private readonly seen = new Map<string, string>();
  private readonly waitingRequests = new Set<string>();
  private readonly listeners: vscode.Disposable[] = [];
  private readDecoration: vscode.TextEditorDecorationType | undefined;
  private editDecoration: vscode.TextEditorDecorationType | undefined;
  private disposed = false;

  constructor(private readonly host: TraceHost) {}

  get isOpening(): boolean { return this.opening; }

  get retainedContext(): EditorSnapshot | undefined {
    return this.human?.document.isClosed ? this.savedContext : undefined;
  }

  editorForContext(fallback: vscode.TextEditor | undefined): vscode.TextEditor | undefined {
    return this.human && !this.human.document.isClosed ? this.human : fallback;
  }

  isAutomaticFile(uri: vscode.Uri): boolean { return this.autoFiles.has(uri.toString()); }

  view(key: ThreadKey | undefined): TraceView {
    const available = !!key && key.environmentId === this.host.environment.descriptor?.environmentId && this.host.environment.ownsWorkspaceFiles;
    const suspended = !!this.pin && (!same(this.pin, key) || !this.host.selected().visible || !vscode.window.state.focused);
    return {
      enabled: !!this.pin, paused: !!this.pin && (this.paused || suspended || this.disconnected), available: available && (!this.pin || same(this.pin, key)) && !this.checkoutInvalid,
      label: this.pin ? `Following ${this.title}` : "Follow thread",
      detail: !this.pin ? (available ? "Follow the agent's file activity without leaving chat." : "Open a thread on this workspace's T3 host to follow its files.")
        : this.disconnected ? (this.host.environment.status.kind === "connected" ? "Activity stream unavailable. Resume to retry." : "Waiting for T3 Code to reconnect.")
        : suspended ? `Following is suspended while ${this.title} is not in view.`
        : this.paused ? this.pauseReason : this.waitingRequests.size ? "Waiting for your response" : this.detail || "Waiting for file activity",
      insight: this.pin ? this.insight : "",
      checkout: this.pin ? this.checkout?.branch ?? "" : "",
      branchDetail: this.pin && this.checkout ? `Thread checkout: ${this.checkout.root} (${this.checkout.branch})${this.humanCheckout ? `\nIDE when pinned: ${this.humanCheckout.root} (${this.humanCheckout.branch})` : ""}` : "",
    };
  }

  toggle(key: ThreadKey | undefined): void {
    if (this.pin) { this.stop(); return; }
    if (!this.view(key).available || !key) return;
    this.human ??= this.host.editor();
    this.idePath = this.human?.document.uri.fsPath;
    if (this.human && !this.human.document.isClosed) this.savedContext = this.host.capture(this.human);
    this.group = vscode.window.tabGroups.all.find(group => group.viewColumn === this.human?.viewColumn) ?? this.group;
    this.pin = key;
    this.checkoutInvalid = false;
    this.checkoutBound = false;
    this.title = this.host.environment.shell.threads.get(key.threadId)?.title ?? "this thread";
    this.installListeners();
    this.startStream();
  }

  resume(key: ThreadKey | undefined): void {
    if (!same(key, this.pin) || !this.pin || this.checkoutInvalid) return;
    this.paused = false;
    if (!this.group || !vscode.window.tabGroups.all.includes(this.group)) {
      this.group = vscode.window.tabGroups.all.find(group => group.viewColumn === this.human?.viewColumn);
    }
    this.detail = "Waiting for file activity";
    if (!this.subscription) this.startStream();
    else this.host.changed();
  }

  selectionChanged(): void {
    const selected = this.host.selected();
    const suspended = !!this.pin && (!same(this.pin, selected.key) || !selected.visible || !vscode.window.state.focused);
    if (suspended !== this.suspended) {
      this.suspended = suspended;
      if (suspended) this.cancelStream();
      else if (this.pin && !this.paused) this.startStream();
    }
    this.host.changed();
  }

  connectionChanged(): void {
    if (!this.pin) return;
    this.cancelStream();
    if (this.host.environment.status.kind === "connected") {
      if (this.host.environment.descriptor?.environmentId !== this.pin.environmentId || !this.host.environment.ownsWorkspaceFiles) this.stop();
      else if (!this.suspended) this.startStream();
    } else { this.disconnected = true; this.host.changed(); }
  }

  stop(): void {
    this.cancelStream();
    this.pin = undefined;
    this.paused = false;
    this.suspended = false;
    this.disconnected = false;
    this.insight = "";
    this.checkoutInvalid = false;
    this.host.changed();
  }

  private cancelStream(): void {
    this.epoch++;
    this.subscription?.cancel();
    this.subscription = undefined;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = undefined;
    this.root = undefined;
    this.projectId = undefined;
    this.sequence = -1;
    this.seen.clear();
    this.waitingRequests.clear();
    this.clearDecorations();
  }

  private startStream(): void {
    if (!this.pin || this.host.environment.status.kind !== "connected") return;
    this.cancelStream();
    const epoch = this.epoch;
    const key = this.pin;
    this.disconnected = false;
    this.detail = "Connecting to file activity";
    try {
      const stream = this.host.environment.subscribe("orchestration.subscribeThread", { threadId: key.threadId, acceptBoundedSnapshot: true }, values => {
        if (epoch !== this.epoch) return;
        for (const raw of values) this.receive(raw, epoch);
      });
      this.subscription = stream;
      const ended = () => {
        if (epoch !== this.epoch) return;
        this.cancelStream();
        this.disconnected = true;
        this.host.changed();
      };
      void stream.done.then(ended, ended);
    } catch {
      this.disconnected = true;
    }
    this.host.changed();
  }

  private receive(raw: unknown, epoch: number): void {
    const frame = record(raw);
    if (!frame || !this.pin) return;
    if (frame.kind === "snapshot") {
      const projection = record(frame.projection), thread = record(projection?.thread);
      if (thread?.id !== this.pin.threadId || typeof frame.snapshotSequence !== "number") return;
      this.sequence = frame.snapshotSequence;
      this.title = typeof thread.title === "string" ? thread.title : this.title;
      const project = typeof thread.projectId === "string" ? this.host.environment.shell.projects.get(thread.projectId) : undefined;
      this.projectId = typeof thread.projectId === "string" ? thread.projectId : undefined;
      const root = typeof thread.worktreePath === "string" ? thread.worktreePath : project?.workspaceRoot;
      if (this.root && root !== this.root) {
        this.checkoutInvalid = true;
        this.pause("Thread checkout changed. Turn following off and on to verify it.");
        return;
      }
      this.root = root;
      if (!this.root) { this.detail = "Waiting for the thread's checkout"; this.host.changed(); return; }
      this.checkoutReady = this.bindCheckout(epoch, typeof thread.branch === "string" ? thread.branch : undefined);
      this.runId = typeof thread.activeRunId === "string" ? thread.activeRunId : undefined;
      this.detail = "Waiting for file activity";
      this.waitingRequests.clear();
      if (Array.isArray(projection?.runtimeRequests)) for (const request of projection.runtimeRequests) this.trackRequest(request);
      const items = Array.isArray(projection?.turnItems) ? projection.turnItems.slice(-500).map(traceItem).filter((item): item is TraceItem => !!item) : [];
      const current = items.filter(item => item.status === "running" && activityPath(item)).at(-1);
      if (current) this.enqueue(current, epoch);
      this.host.changed();
      return;
    }
    if (typeof frame.sequence !== "number" || frame.sequence <= this.sequence) return;
    this.sequence = frame.sequence;
    if (frame.kind !== "event") return;
    const event = record(frame.event), payload = record(event?.payload);
    if (typeof payload?.threadId === "string" && payload.threadId !== this.pin.threadId) return;
    if (event?.type === "turn-item.updated") {
      const item = traceItem(payload);
      if (!item || item.threadId !== this.pin.threadId) return;
      if (item.runId && item.runId !== this.runId) { this.runId = item.runId; this.insight = ""; }
      if (item.type === "assistant_message" && item.status === "completed" && item.text) {
        this.insight = publicInsight(item.text) ?? this.insight;
        this.host.changed();
      } else if (activityPath(item)) this.enqueue(item, epoch);
      else if (["command_execution", "file_search", "web_search"].includes(item.type)) {
        this.detail = item.type === "command_execution" ? "Running a command" : "Searching";
        if (item.status !== "running") this.detail = failedItem(item) ? "Operation failed" : "Operation finished";
        this.host.changed();
      }
    } else if (event?.type === "run.updated" && ["completed", "failed", "cancelled", "interrupted"].includes(String(payload?.status))) {
      this.pending = undefined;
      this.clearDecorations();
      this.detail = payload?.status === "completed" ? "Turn finished" : "Turn stopped";
      this.host.changed();
    } else if (event?.type === "runtime-request.updated") {
      this.trackRequest(payload);
      if (this.waitingRequests.size) { this.pending = undefined; this.clearDecorations(); }
      this.host.changed();
    }
  }

  private enqueue(item: TraceItem, epoch: number): void {
    if (!this.canNavigate(epoch)) return;
    if (["pending", "waiting"].includes(item.status)) {
      this.pending = undefined;
      this.clearDecorations();
      this.detail = "Waiting for the file operation";
      this.host.changed();
      return;
    }
    const revision = `${item.status}:${item.updatedAt ?? ""}:${item.diffStr?.length ?? 0}`;
    if (this.seen.get(item.id) === revision) return;
    this.seen.set(item.id, revision);
    if (this.seen.size > 128) this.seen.delete(this.seen.keys().next().value!);
    // Bound visual work to the latest target instead of replaying a backlog of tool output.
    this.pending = item;
    this.schedule(epoch);
  }

  private schedule(epoch: number): void {
    if (this.timer || this.busy || !this.pending) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const item = this.pending;
      this.pending = undefined;
      if (!item || !this.canNavigate(epoch)) return;
      this.busy = true;
      void this.display(item, epoch).catch(() => {
        if (epoch === this.epoch) { this.detail = "File activity unavailable"; this.clearDecorations(); this.host.changed(); }
      }).finally(() => { this.busy = false; this.schedule(this.epoch); });
    }, Math.max(180, 1000 - (Date.now() - this.lastOpened)));
  }

  private canNavigate(epoch: number): boolean {
    const selected = this.host.selected();
    return epoch === this.epoch && !!this.pin && same(this.pin, selected.key) && selected.visible && !this.paused && !this.disconnected && !this.waitingRequests.size && vscode.window.state.focused;
  }

  private trackRequest(value: unknown): void {
    const request = record(value);
    if (typeof request?.id !== "string") return;
    // Message-based questions can remain pending while the agent continues working.
    if (request.status === "pending" && record(request.responseCapability)?.type === "live") this.waitingRequests.add(request.id);
    else this.waitingRequests.delete(request.id);
  }

  private async display(item: TraceItem, epoch: number): Promise<void> {
    if (!this.root || !this.canNavigate(epoch)) return;
    await this.checkoutReady;
    if (!this.canNavigate(epoch) || this.checkoutInvalid) return;
    if (failedItem(item)) { this.clearDecorations(); this.detail = "File operation failed"; this.host.changed(); return; }
    const path = activityPath(item);
    const target = path && await resolveTracePath(path, this.root);
    if (!target || !this.canNavigate(epoch)) {
      if (this.canNavigate(epoch)) { this.detail = "File unavailable in this checkout"; this.clearDecorations(); this.host.changed(); }
      return;
    }
    if (!this.group || !vscode.window.tabGroups.all.includes(this.group) || this.group.tabs.some(tab => tab.input instanceof vscode.TabInputWebview && tab.input.viewType === "threadside.chat")) {
      this.pause("Open code beside the chat, then resume following."); return;
    }
    const info = await stat(target);
    if (!info.isFile() || info.size > 1_000_000 || /\.(png|jpe?g|gif|webp|pdf|mp[34]|zip|woff2?|ttf|ico)$/i.test(target)) { this.detail = `File activity: ${basename(target)}`; this.host.changed(); return; }
    let full = item;
    if (!item.diffStr && item.output === undefined) {
      try {
        const response = record(await this.host.environment.call("orchestration.getTurnItem", { threadId: item.threadId, itemId: item.id }));
        const detail = traceItem(response?.item);
        if (detail?.id === item.id && detail.threadId === item.threadId) full = detail;
      } catch { /* File-level activity remains useful when details are unavailable. */ }
    }
    if (!this.canNavigate(epoch) || failedItem(full)) return;
    const uri = this.host.toUri(target);
    const document = await vscode.workspace.openTextDocument(uri);
    if (!this.canNavigate(epoch)) return;
    if (document.isDirty) { this.pause("Unsaved changes in this file. Resume when ready."); return; }
    if (document.getText().includes("\0")) return;
    const [checkout, humanCheckout] = await Promise.all([
      traceCheckout(this.root), this.idePath ? traceCheckout(this.idePath) : Promise.resolve(undefined),
    ]);
    if (!this.canNavigate(epoch)) return;
    if (!sameCheckout(this.checkout, checkout) || !sameCheckout(this.humanCheckout, humanCheckout)) {
      this.checkoutInvalid = true;
      this.pause("Checkout changed. Turn following off and on to verify the branch.");
      return;
    }
    const existed = vscode.window.tabGroups.all.some(group => group.tabs.some(tab => tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri.toString()));
    this.opening = true;
    try {
      this.clearDecorations();
      const editor = await vscode.window.showTextDocument(document, { viewColumn: this.group.viewColumn, preserveFocus: true, preview: true });
      if (!existed) this.autoFiles.add(uri.toString());
      const openFiles = new Set(vscode.window.tabGroups.all.flatMap(group => group.tabs.flatMap(tab => tab.input instanceof vscode.TabInputText ? [tab.input.uri.toString()] : [])));
      for (const file of this.autoFiles) if (!openFiles.has(file)) this.autoFiles.delete(file);
      if (!this.canNavigate(epoch)) return;
      this.shown = editor;
      const text = document.getText();
      const spans = full.type === "file_change" && full.diffStr ? patchSpans(full.diffStr, text) : readSpans(full.output, text);
      const ranges = spans.map(([start, end]) => new vscode.Range(start, 0, end, Number.MAX_SAFE_INTEGER));
      const changed = full.type === "file_change";
      editor.setDecorations(this.decoration(changed), ranges);
      if (ranges[0]) editor.revealRange(ranges[0], vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      this.lastOpened = Date.now();
      this.detail = `${changed ? (ranges.length ? "Changed" : "Change reported") : (full.status === "running" ? "Reading" : ranges.length ? "Read" : "Read reported")} ${basename(target)}${(full.changes?.length ?? 0) > 1 ? ` +${full.changes!.length - 1} files` : ""}${ranges.length ? "" : " · file-level activity"}`;
      this.host.changed();
      if (full.status !== "running") this.fade = setTimeout(() => this.clearDecorations(), 1800);
    } finally {
      // VS Code reports a reveal's viewport event after showTextDocument resolves, without an input origin.
      this.programmaticScrollUntil = Date.now() + 200;
      this.opening = false;
    }
  }

  private decoration(changed: boolean): vscode.TextEditorDecorationType {
    const existing = changed ? this.editDecoration : this.readDecoration;
    if (existing) return existing;
    const decoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true, rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
      backgroundColor: new vscode.ThemeColor(changed ? "threadside.traceEditBackground" : "threadside.traceReadBackground"),
      borderColor: new vscode.ThemeColor(changed ? "gitDecoration.addedResourceForeground" : "editorInfo.foreground"), borderWidth: "0 0 0 2px", borderStyle: "solid",
    });
    if (changed) this.editDecoration = decoration; else this.readDecoration = decoration;
    return decoration;
  }

  private async bindCheckout(epoch: number, expectedBranch: string | undefined): Promise<void> {
    const [checkout, humanCheckout] = await Promise.all([
      this.root ? traceCheckout(this.root) : Promise.resolve(undefined),
      this.idePath ? traceCheckout(this.idePath) : Promise.resolve(undefined),
    ]);
    if (epoch !== this.epoch) return;
    if (this.checkoutBound && (!sameCheckout(this.checkout, checkout) || !sameCheckout(this.humanCheckout, humanCheckout))) {
      this.checkoutInvalid = true;
      this.pause("Checkout changed. Turn following off and on to verify the branch.");
      return;
    }
    this.checkout = checkout;
    this.humanCheckout = humanCheckout;
    this.checkoutBound = true;
    if (expectedBranch && (!checkout || checkout.branch !== expectedBranch)) {
      this.checkoutInvalid = true;
      this.pause(`Thread expects ${expectedBranch}, but its checkout is ${checkout?.branch ?? "unverified"}. Open the correct checkout before following.`);
    }
    this.host.changed();
  }

  private clearDecorations(): void {
    clearTimeout(this.fade);
    if (this.shown && this.readDecoration) this.shown.setDecorations(this.readDecoration, []);
    if (this.shown && this.editDecoration) this.shown.setDecorations(this.editDecoration, []);
  }

  private pause(message: string): void {
    if (!this.pin) return;
    this.paused = true;
    this.pauseReason = message;
    this.pending = undefined;
    this.clearDecorations();
    this.detail = message;
    this.host.changed();
  }

  private adoptHuman(editor: vscode.TextEditor): void {
    this.human = editor;
    this.autoFiles.delete(editor.document.uri.toString());
    this.savedContext = this.host.capture(editor);
    this.group = vscode.window.tabGroups.all.find(group => group.viewColumn === editor.viewColumn);
    this.pause("You are navigating the code. Resume when ready.");
  }

  private installListeners(): void {
    if (this.listeners.length) return;
    this.listeners.push(
      this.host.environment.shell.onDidChange(() => {
        if (this.pin && !this.root && this.projectId && !this.suspended && !this.paused && this.host.environment.shell.projects.has(this.projectId)) this.startStream();
      }),
      vscode.window.onDidChangeActiveTextEditor(editor => { if (editor && !this.opening) this.adoptHuman(editor); }),
      vscode.window.onDidChangeTextEditorSelection(event => {
        if (event.kind === vscode.TextEditorSelectionChangeKind.Mouse || event.kind === vscode.TextEditorSelectionChangeKind.Keyboard) this.adoptHuman(event.textEditor);
      }),
      vscode.window.onDidChangeTextEditorVisibleRanges(event => { if (!this.opening && Date.now() >= this.programmaticScrollUntil && this.pin && event.textEditor === this.shown) this.pause("You scrolled the code. Resume when ready."); }),
      vscode.workspace.onDidChangeTextDocument(event => {
        if (event.contentChanges.length && this.shown?.document === event.document) {
          this.clearDecorations();
          if (event.document.isDirty) this.pause("You are editing this file. Resume when ready.");
        }
      }),
      vscode.window.onDidChangeWindowState(() => this.selectionChanged()),
    );
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelStream();
    this.pin = undefined;
    for (const listener of this.listeners) listener.dispose();
    this.readDecoration?.dispose();
    this.editDecoration?.dispose();
    this.autoFiles.clear();
    this.savedContext = undefined;
    this.human = undefined;
    this.shown = undefined;
    this.group = undefined;
  }
}
