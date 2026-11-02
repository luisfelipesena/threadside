import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import type { Environment } from "../connection/environment";
import { log } from "../log";
import type { AuthProxy } from "../proxy/authProxy";
import { threadIdFromPath } from "../routes";

export const VIEW_TYPE = "threadside.chat";
/** The chat docked in a side bar (the Secondary Side Bar by default), like Cursor's chat pane. */
export const SIDE_VIEW_ID = "threadside.chatView";

interface PanelState {
  path?: string;
}

/** Shortcuts that run editor commands while the chat has focus, from `threadside.chatShortcuts`. */
export function chatShortcuts(): Record<string, string> {
  const map = vscode.workspace.getConfiguration("threadside").get<Record<string, string>>("chatShortcuts", {});
  return Object.fromEntries(Object.entries(map).filter(([chord, command]) => chord && typeof command === "string" && command));
}

export interface BridgeMessage {
  type: string;
  [key: string]: unknown;
}

export interface ChatHost {
  environment: Environment;
  proxy: AuthProxy;
  proxyOrigin(): Promise<string>;
  onBridgeMessage(panel: ChatPanel, message: BridgeMessage): void;
  onPanelChanged(): void;
}

/**
 * One chat: an editor tab or the docked side view, each a webview that hosts T3 Code's own UI from
 * the auth proxy.
 */
export class ChatPanel {
  path: string;
  /** Whether keyboard focus is inside the chat (the page reports focus and blur). */
  private focused = false;
  /** Runs once, when the chat UI first reports it is ready. */
  onFirstReady: (() => void) | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly disposeEmitter = new vscode.EventEmitter<void>();
  readonly onDidDispose = this.disposeEmitter.event;

  constructor(
    private readonly surface: vscode.WebviewPanel | vscode.WebviewView,
    private readonly host: ChatHost,
    state: PanelState | undefined,
  ) {
    this.path = state?.path ?? "/";
    if (this.panel) {
      this.panel.iconPath = {
        light: vscode.Uri.joinPath(extensionUri(), "media", "chat-light.svg"),
        dark: vscode.Uri.joinPath(extensionUri(), "media", "chat-dark.svg"),
      };
    }
    surface.webview.options = { enableScripts: true, localResourceRoots: [] };
    this.disposables.push(
      surface.webview.onDidReceiveMessage((message: BridgeMessage) => this.receive(message)),
      this.panel ? this.panel.onDidChangeViewState(() => host.onPanelChanged()) : (surface as vscode.WebviewView).onDidChangeVisibility(() => host.onPanelChanged()),
      surface.onDidDispose(() => this.dispose()),
      vscode.window.onDidChangeActiveColorTheme(() => this.postTheme()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("threadside")) this.postConfig();
      }),
    );
    void this.render();
  }

  /** The editor tab, or undefined for the docked side view. */
  get panel(): vscode.WebviewPanel | undefined {
    return "reveal" in this.surface ? this.surface : undefined;
  }

  get isSideView(): boolean {
    return !this.panel;
  }

  /** The chat has focus: the active editor tab, or the side view with focus inside it. */
  get active(): boolean {
    return this.panel ? this.panel.active : this.surface.visible && this.focused;
  }

  get visible(): boolean {
    return this.surface.visible;
  }

  setTitle(title: string): void {
    if (this.panel) {
      if (this.panel.title !== title) this.panel.title = title;
    } else if ((this.surface as vscode.WebviewView).description !== title) {
      (this.surface as vscode.WebviewView).description = title;
    }
  }

  get threadId(): string | undefined {
    return threadIdFromPath(this.path);
  }

  /** The server this tab last loaded from; undefined while it showed the "not connected" page. */
  renderedFor: string | undefined;

  async render(httpBaseUrl?: string): Promise<void> {
    this.renderedFor = httpBaseUrl ?? (this.host.environment.status.kind === "connected" ? this.host.environment.status.httpBaseUrl : undefined);
    const nonce = randomBytes(16).toString("base64");
    const webview = this.surface.webview;
    if (!this.renderedFor) {
      webview.html = hostHtml(undefined, "", nonce, webview.cspSource);
      return;
    }
    const origin = await this.host.proxyOrigin();
    const src = this.host.proxy.entryUrl(origin, this.path, themeKind());
    webview.html = hostHtml(src, new URL(origin).origin, nonce, webview.cspSource);
  }

  navigate(path: string): void {
    this.path = path;
    this.post({ type: "navigate", path });
  }

  insert(text: string): void {
    this.post({ type: "insert", text });
  }

  insertMentions(mentions: string[]): void {
    this.post({ type: "mentions", mentions });
  }

  focusComposer(): void {
    this.post({ type: "focusComposer" });
  }

  reveal(preserveFocus = false): void {
    if (this.panel) this.panel.reveal(undefined, preserveFocus);
    else (this.surface as vscode.WebviewView).show(preserveFocus);
  }

  post(message: Record<string, unknown>): void {
    void this.surface.webview.postMessage({ source: "threadside-host", ...message });
  }

  private postConfig(): void {
    this.post({
      type: "config",
      shortcuts: Object.keys(chatShortcuts()),
      compactChat: vscode.workspace.getConfiguration("threadside").get("compactChat", true),
      openFilesInEditor: vscode.workspace.getConfiguration("threadside").get("openFileLinksInEditor", true),
      matchEditorColors: vscode.workspace.getConfiguration("threadside").get("matchEditorColors", true),
    });
  }

  private postTheme(): void {
    this.post({ type: "theme", theme: themeKind() });
  }

  private receive(message: BridgeMessage): void {
    switch (message.type) {
      case "ready": {
        this.postConfig();
        this.postTheme();
        const first = this.onFirstReady;
        this.onFirstReady = undefined;
        if (first) setTimeout(first, 300);
        break;
      }
      case "route":
        if (typeof message.path === "string") {
          this.path = message.path;
          this.host.onPanelChanged();
        }
        break;
      case "shortcut": {
        // Only commands from the shortcut map run; the page cannot name a command itself.
        const command = chatShortcuts()[String(message.chord)];
        if (command) void vscode.commands.executeCommand(command);
        break;
      }
      case "clientError":
        log().error(`Chat page error on ${String(message.path)}: ${String(message.message)}${message.detail ? `\n${String(message.detail)}` : ""}`);
        break;
      case "frameProblem":
        log().error(`Chat tab problem: ${String(message.title)} ${String(message.detail ?? "")} (page ${this.path})`);
        break;
      case "reload":
        void this.render();
        break;
      case "showLog":
        log().show();
        break;
      case "connect":
        void vscode.commands.executeCommand("threadside.connect");
        break;
      case "focus":
        this.focused = true;
        break;
      case "blur":
        this.focused = false;
        break;
      default:
        break;
    }
    this.host.onBridgeMessage(this, message);
  }

  dispose(): void {
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
    this.disposeEmitter.fire();
    this.disposeEmitter.dispose();
  }
}

function themeKind(): "light" | "dark" {
  const kind = vscode.window.activeColorTheme.kind;
  return kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight ? "light" : "dark";
}

let extensionRoot: vscode.Uri | undefined;
export function setExtensionUri(uri: vscode.Uri): void {
  extensionRoot = uri;
}
function extensionUri(): vscode.Uri {
  if (!extensionRoot) throw new Error("Threadside extension URI not set.");
  return extensionRoot;
}

/**
 * The host page: a full-bleed iframe on the proxy origin plus a relay. Messages from the frame go to
 * the extension; messages from the extension go to the frame. A watchdog replaces a blank tab with a
 * clear error, a Reload button and the log.
 */
function hostHtml(src: string | undefined, frameOrigin: string, nonce: string, cspSource: string): string {
  const csp = [
    "default-src 'none'",
    ...(src ? [`frame-src ${frameOrigin}`] : []),
    `script-src 'nonce-${nonce}'`,
    `style-src 'unsafe-inline' ${cspSource}`,
  ].join("; ");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; background: var(--vscode-editor-background); color: var(--vscode-foreground); font: 13px/1.5 var(--vscode-font-family); }
  iframe { position: fixed; inset: 0; width: 100%; height: 100%; border: 0; display: block; }
  .notice { position: fixed; inset: 0; display: grid; place-items: center; padding: 24px; text-align: center; background: var(--vscode-editor-background); }
  .notice[hidden] { display: none; }
  .notice p { margin: 0 0 4px; max-width: 420px; }
  .notice .muted { color: var(--vscode-descriptionForeground); }
  .notice .actions { margin-top: 14px; display: flex; gap: 8px; justify-content: center; }
  .notice button { font: inherit; padding: 4px 12px; border-radius: 2px; border: 1px solid var(--vscode-button-border, transparent); cursor: pointer; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .notice button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  #loading { pointer-events: none; color: var(--vscode-descriptionForeground); transition: opacity .2s; }
  body.ready #loading { opacity: 0; }
</style>
</head>
<body>
${
  src
    ? `<iframe id="chat" src="${escapeAttr(src)}" allow="clipboard-read; clipboard-write; microphone; camera; autoplay; fullscreen; display-capture" allowfullscreen></iframe>
<div id="loading" class="notice"><p>Connecting to T3 Code…</p></div>`
    : `<div id="offline" class="notice"><div>
  <p><strong>T3 Code is not connected</strong></p>
  <p class="muted">Use the T3 Code server on this machine, or pair with one on another.</p>
  <div class="actions"><button id="connect" class="primary">Connect…</button><button id="offline-log">Show Log</button></div>
</div></div>`
}
<div id="error" class="notice" hidden>
  <div>
    <p id="error-title">The chat did not load.</p>
    <p id="error-detail" class="muted"></p>
    <div class="actions"><button id="reload" class="primary">Reload</button><button id="log">Show Log</button></div>
  </div>
</div>
<script nonce="${nonce}">
(function () {
  const vscode = acquireVsCodeApi();
  const frame = document.getElementById("chat");
  if (!frame) {
    document.getElementById("connect").addEventListener("click", () => vscode.postMessage({ source: "threadside-host", type: "connect" }));
    document.getElementById("offline-log").addEventListener("click", () => vscode.postMessage({ source: "threadside-host", type: "showLog" }));
    return;
  }
  const origin = ${JSON.stringify(frameOrigin)};
  const errorBox = document.getElementById("error");
  let watchdog;
  let matchColors = true;

  function showError(title, detail) {
    document.getElementById("error-title").textContent = title;
    document.getElementById("error-detail").textContent = detail || "";
    errorBox.hidden = false;
    vscode.postMessage({ source: "threadside-host", type: "frameProblem", title, detail });
  }
  // Every document the frame loads must announce itself; one that does not (an error page, a
  // navigation away from T3 Code) would otherwise leave a blank tab.
  function armWatchdog(ms) {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => showError("The chat did not load.", "T3 Code did not answer. Check that the server is running, then reload."), ms);
  }
  // Each document says "ready" (DOMContentLoaded) before its load event; a document that loads
  // without saying it is not T3 Code's app (an error page, or a navigation away from it).
  let readySinceLoad = false;
  armWatchdog(20000);
  frame.addEventListener("load", () => {
    if (readySinceLoad) clearTimeout(watchdog);
    else armWatchdog(3000);
    readySinceLoad = false;
  });
  document.getElementById("reload").addEventListener("click", () => vscode.postMessage({ source: "threadside-host", type: "reload" }));
  document.getElementById("log").addEventListener("click", () => vscode.postMessage({ source: "threadside-host", type: "showLog" }));

  // Keys typed into the tab belong to the chat, so focus always moves on into the frame.
  window.addEventListener("focus", () => frame.focus());
  document.addEventListener("mousedown", (event) => { if (errorBox.hidden) frame.focus(); });

  // The editor's live theme colors, read from the webview's --vscode-* variables.
  function palette() {
    const css = getComputedStyle(document.documentElement);
    const v = (name) => css.getPropertyValue("--vscode-" + name).trim();
    return {
      background: v("editor-background"),
      foreground: v("foreground") || v("editor-foreground"),
      card: v("editorWidget-background") || v("sideBar-background"),
      popover: v("quickInput-background") || v("editorWidget-background"),
      sidebar: v("sideBar-background"),
      border: v("panel-border") || v("widget-border") || v("editorGroup-border"),
      mutedForeground: v("descriptionForeground"),
      accent: v("list-hoverBackground"),
      fontSans: v("font-family"),
      fontMono: v("editor-font-family"),
    };
  }
  function sendPalette() {
    frame.contentWindow.postMessage({ source: "threadside-host", type: "palette", enabled: matchColors, vars: palette() }, origin);
  }

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || typeof data !== "object") return;
    if (event.source === frame.contentWindow) {
      if (event.origin !== origin || data.source !== "threadside-bridge") return;
      if (data.type === "ready") {
        readySinceLoad = true;
        clearTimeout(watchdog);
        errorBox.hidden = true;
        document.body.classList.add("ready");
        sendPalette();
      }
      if (data.type === "route") vscode.setState({ path: data.path });
      vscode.postMessage(data);
      return;
    }
    // From the extension: the webview shell posts with this page's own origin, which no other frame
    // (the chat or anything inside it) can claim.
    if (event.origin !== window.origin || data.source !== "threadside-host") return;
    if (data.type === "focusComposer" || data.type === "insert" || data.type === "mentions") frame.focus();
    if (data.type === "config") matchColors = data.matchEditorColors !== false;
    frame.contentWindow.postMessage(data, origin);
    // The webview updates its --vscode-* variables after a theme change; read them next frame.
    if (data.type === "theme" || data.type === "config") requestAnimationFrame(() => setTimeout(sendPalette, 50));
  });
})();
</script>
</body>
</html>`;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
