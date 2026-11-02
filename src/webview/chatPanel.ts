import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import type { Environment } from "../connection/environment";
import { log } from "../log";
import type { AuthProxy } from "../proxy/authProxy";
import { threadIdFromPath } from "../routes";

export const VIEW_TYPE = "threadside.chat";


interface PanelState {
  path?: string;
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

/** One chat tab: an editor-area webview that hosts T3 Code's own UI from the auth proxy. */
export class ChatPanel {
  path: string;
  title = "T3";
  /** Runs once, when the chat UI first reports it is ready. */
  onFirstReady: (() => void) | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly disposeEmitter = new vscode.EventEmitter<void>();
  readonly onDidDispose = this.disposeEmitter.event;

  constructor(
    readonly panel: vscode.WebviewPanel,
    private readonly host: ChatHost,
    state: PanelState | undefined,
  ) {
    this.path = state?.path ?? "/";
    panel.iconPath = {
      light: vscode.Uri.joinPath(extensionUri(), "media", "chat-light.svg"),
      dark: vscode.Uri.joinPath(extensionUri(), "media", "chat-dark.svg"),
    };
    panel.webview.options = { enableScripts: true, localResourceRoots: [] };
    this.disposables.push(
      panel.webview.onDidReceiveMessage((message: BridgeMessage) => this.receive(message)),
      panel.onDidChangeViewState(() => host.onPanelChanged()),
      panel.onDidDispose(() => this.dispose()),
      vscode.window.onDidChangeActiveColorTheme(() => this.postTheme()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("threadside")) this.postConfig();
      }),
    );
    void this.render();
  }

  get threadId(): string | undefined {
    return threadIdFromPath(this.path);
  }

  /** The server this tab last loaded from; undefined while it showed the "not connected" page. */
  renderedFor: string | undefined;

  async render(httpBaseUrl?: string): Promise<void> {
    this.renderedFor = httpBaseUrl ?? (this.host.environment.status.kind === "connected" ? this.host.environment.status.httpBaseUrl : undefined);
    const origin = await this.host.proxyOrigin();
    const theme = themeKind();
    const src = this.host.proxy.entryUrl(origin, this.path, theme);
    const nonce = randomBytes(16).toString("base64");
    this.panel.webview.html = hostHtml(src, new URL(origin).origin, nonce, this.panel.webview.cspSource);
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
    this.panel.reveal(undefined, preserveFocus);
  }

  post(message: Record<string, unknown>): void {
    void this.panel.webview.postMessage({ source: "threadside-host", ...message });
  }

  private postConfig(): void {
    this.post({
      type: "config",
      editorKeys: vscode.workspace.getConfiguration("threadside").get<string[]>("editorKeysInChat", []),
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
      case "frameError":
        log().warn(`Chat frame failed to load: ${String(message.detail ?? "")}`);
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
 * The host page: a full-bleed iframe on the proxy origin plus a relay. Messages from the iframe go
 * to the extension; messages from the extension go to the iframe. Keys the chat leaves alone are
 * re-dispatched here so the editor's keybindings still run.
 */
function hostHtml(src: string, frameOrigin: string, nonce: string, cspSource: string): string {
  const csp = [
    "default-src 'none'",
    `frame-src ${frameOrigin}`,
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
  html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; background: var(--vscode-editor-background); }
  iframe { position: fixed; inset: 0; width: 100%; height: 100%; border: 0; display: block; }
  #status { position: fixed; inset: 0; display: grid; place-items: center; font: 13px var(--vscode-font-family); color: var(--vscode-descriptionForeground); pointer-events: none; transition: opacity .2s; }
  body.loaded #status { opacity: 0; }
</style>
</head>
<body>
<div id="status">Connecting to T3 Code…</div>
<iframe id="chat" src="${escapeAttr(src)}" allow="clipboard-read; clipboard-write; microphone; camera; autoplay; fullscreen; display-capture" allowfullscreen></iframe>
<script nonce="${nonce}">
(function () {
  const vscode = acquireVsCodeApi();
  const frame = document.getElementById("chat");
  const origin = ${JSON.stringify(frameOrigin)};
  frame.addEventListener("load", () => document.body.classList.add("loaded"));
  // Keys typed into the tab belong to the chat, so focus always moves on into the frame.
  window.addEventListener("focus", () => frame.focus());
  document.addEventListener("mousedown", () => frame.focus());
  let matchColors = true;
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
    if (event.source === frame.contentWindow && event.origin === origin && data.source === "threadside-bridge") {
      if (data.type === "ready") sendPalette();
      if (data.type === "key") {
        window.dispatchEvent(new KeyboardEvent("keydown", {
          key: data.key, code: data.code, keyCode: data.keyCode, which: data.keyCode,
          metaKey: data.metaKey, ctrlKey: data.ctrlKey, altKey: data.altKey, shiftKey: data.shiftKey,
          repeat: data.repeat, bubbles: true, cancelable: true,
        }));
        return;
      }
      if (data.type === "route") vscode.setState({ path: data.path });
      vscode.postMessage(data);
      return;
    }
    // Messages from the extension arrive from the webview shell (this window's parent, same origin).
    if (data.source === "threadside-host" && event.source === window.parent && event.origin === window.origin) {
      if (data.type === "focusComposer" || data.type === "insert" || data.type === "mentions") frame.focus();
      if (data.type === "config") matchColors = data.matchEditorColors !== false;
      frame.contentWindow.postMessage(data, origin);
      // The webview updates its --vscode-* variables after a theme change; read them next frame.
      if (data.type === "theme" || data.type === "config") requestAnimationFrame(() => setTimeout(sendPalette, 50));
    }
  });
})();
</script>
</body>
</html>`;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
