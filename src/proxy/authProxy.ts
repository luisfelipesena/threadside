import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import type { AddressInfo, Socket } from "node:net";
import type { ConnectionTarget } from "../connection/environment";
import { log, redact } from "../log";
import { BRIDGE_PATH, injectBridge, upstreamUrl } from "./upstream";

const KEY_PARAM = "threadside_key";
const THEME_PARAM = "threadside_theme";
/** Only the editor may frame the chat: its workbench and webview origins. */
const FRAME_ANCESTORS = "frame-ancestors 'self' vscode-webview: vscode-file:";

/**
 * Serves the connected T3 Code server's own web build on loopback and adds the bearer token on the
 * way out, so the chat UI is always the exact version the server ships. The webview loads this
 * origin in an iframe.
 *
 * Who may use it: each window has a random key, set once as an HttpOnly cookie named after the
 * port (so two windows never overwrite each other); requests that carry an Origin must come from
 * the webview's own origin; cross-site requests other than the frame's own navigation are refused.
 */
export class AuthProxy {
  private server: http.Server | undefined;
  private port = 0;
  private readonly key = randomBytes(24).toString("base64url");
  private target: ConnectionTarget | undefined;
  private readonly allowedOrigins = new Set<string>();
  private readonly bridgeSource: string;

  constructor(bridgeFile: string) {
    this.bridgeSource = readFileSync(bridgeFile, "utf8");
  }

  setTarget(target: ConnectionTarget | undefined): void {
    this.target = target;
  }

  /** The origin the webview reaches this proxy at (loopback, or the editor's forwarded port). */
  allowOrigin(origin: string): void {
    this.allowedOrigins.add(origin);
  }

  private get keyCookie(): string {
    return `threadside_key_${this.port}`;
  }

  /** Starts on the preferred port when free, so the iframe origin (and its saved UI state) is stable. */
  async start(preferredPort: number | undefined): Promise<number> {
    if (this.server) return this.port;
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch((error: Error) => {
        log().warn(`Proxy request failed: ${redact(error.message)}`);
        if (!res.headersSent) res.writeHead(503, { "content-type": "text/plain" });
        res.end("Threadside could not reach T3 Code.");
      });
    });
    server.on("upgrade", (req, socket: Socket, head) => {
      socket.on("error", () => socket.destroy());
      this.upgrade(req, socket, head).catch(() => socket.destroy());
    });
    server.keepAliveTimeout = 30_000;
    const listen = (port: number) =>
      new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          server.off("error", reject);
          resolve((server.address() as AddressInfo).port);
        });
      });
    try {
      this.port = await listen(preferredPort ?? 0);
    } catch {
      this.port = await listen(0);
    }
    this.server = server;
    return this.port;
  }

  /** The entry URL; its one-time parameters set the key and theme cookies and are stripped by a redirect. */
  entryUrl(origin: string, path = "/", theme: "light" | "dark" = "dark"): string {
    const url = new URL(path, origin);
    url.searchParams.set(KEY_PARAM, this.key);
    url.searchParams.set(THEME_PARAM, theme);
    return url.toString();
  }

  dispose(): void {
    this.server?.close();
    this.server?.closeAllConnections?.();
    this.server = undefined;
  }

  private hasKey(req: http.IncomingMessage): boolean {
    const cookie = parseCookies(req.headers.cookie)[this.keyCookie];
    return cookie !== undefined && safeEqual(cookie, this.key);
  }

  /** Origin, when present, must be the webview's; without one, only the frame's own navigation may be cross-site. */
  private fromWebview(req: http.IncomingMessage, upgrade: boolean): boolean {
    const origin = req.headers.origin;
    if (origin !== undefined) return this.allowedOrigins.has(origin);
    if (upgrade) return false;
    const site = req.headers["sec-fetch-site"];
    if (site === "cross-site" || site === "same-site") {
      return req.headers["sec-fetch-mode"] === "navigate" && req.headers["sec-fetch-dest"] === "iframe";
    }
    return true;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://proxy.invalid");
    const presented = url.searchParams.get(KEY_PARAM);
    if (presented !== null) {
      if (!safeEqual(presented, this.key) || !this.fromWebview(req, false)) return deny(res);
      const theme = url.searchParams.get(THEME_PARAM) === "light" ? "light" : "dark";
      url.searchParams.delete(KEY_PARAM);
      url.searchParams.delete(THEME_PARAM);
      res.writeHead(302, {
        location: url.pathname + url.search + url.hash,
        "set-cookie": [
          `${this.keyCookie}=${this.key}; Path=/; HttpOnly; SameSite=None; Secure`,
          // Read by the bridge before the app starts, so the first paint already matches the editor.
          `${THEME_PARAM}_${this.port}=${theme}; Path=/; SameSite=None; Secure`,
        ],
        "cache-control": "no-store",
      });
      res.end();
      return;
    }
    if (!this.hasKey(req) || !this.fromWebview(req, false)) return deny(res);
    if (url.pathname === BRIDGE_PATH) {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
      res.end(this.bridgeSource);
      return;
    }
    const target = this.target;
    if (!target) {
      res.writeHead(503, { "content-type": "text/plain", "cache-control": "no-store" });
      res.end("Threadside is not connected to T3 Code yet.");
      return;
    }
    const upstream = upstreamUrl(target.httpBaseUrl, url);
    const isDocument = req.method === "GET" && (req.headers["sec-fetch-dest"] === "iframe" || req.headers["sec-fetch-dest"] === "document");
    const headers = await this.upstreamHeaders(req, target, upstream);
    if (isDocument) headers["accept-encoding"] = "identity";
    const client = upstream.protocol === "https:" ? https : http;
    const proxied = client.request(upstream, { method: req.method, headers }, (upstreamRes) => {
      const responseHeaders = { ...upstreamRes.headers };
      delete responseHeaders["set-cookie"];
      const type = String(upstreamRes.headers["content-type"] ?? "");
      if (isDocument && type.includes("text/html")) {
        const chunks: Buffer[] = [];
        upstreamRes.on("data", (chunk: Buffer) => chunks.push(chunk));
        upstreamRes.on("end", () => {
          const html = injectBridge(Buffer.concat(chunks).toString("utf8"));
          delete responseHeaders["content-length"];
          delete responseHeaders["content-encoding"];
          responseHeaders["cache-control"] = "no-store";
          responseHeaders["content-security-policy"] = FRAME_ANCESTORS;
          res.writeHead(upstreamRes.statusCode ?? 200, responseHeaders);
          res.end(html);
        });
        return;
      }
      res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);
      upstreamRes.pipe(res);
    });
    proxied.on("error", (error) => {
      log().warn(`Proxy request failed: ${redact(error.message)}`);
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end("T3 Code is not reachable.");
    });
    req.pipe(proxied);
  }

  private async upgrade(req: http.IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
    const target = this.target;
    if (!this.hasKey(req) || !this.fromWebview(req, true) || !target) {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const upstream = upstreamUrl(target.httpBaseUrl, new URL(req.url ?? "/", "http://proxy.invalid"));
    const headers = await this.upstreamHeaders(req, target, upstream);
    const client = upstream.protocol === "https:" ? https : http;
    const proxied = client.request(upstream, { method: "GET", headers });
    proxied.on("upgrade", (upstreamRes, upstreamSocket, upstreamHead) => {
      const lines = [`HTTP/1.1 ${upstreamRes.statusCode} ${upstreamRes.statusMessage}`];
      for (let i = 0; i < upstreamRes.rawHeaders.length; i += 2) {
        lines.push(`${upstreamRes.rawHeaders[i]}: ${upstreamRes.rawHeaders[i + 1]}`);
      }
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) upstreamSocket.write(head);
      upstreamSocket.pipe(socket).pipe(upstreamSocket);
      const close = () => {
        socket.destroy();
        upstreamSocket.destroy();
      };
      socket.on("error", close);
      socket.on("close", close);
      upstreamSocket.on("error", close);
      upstreamSocket.on("close", close);
    });
    proxied.on("response", (upstreamRes) => {
      socket.end(`HTTP/1.1 ${upstreamRes.statusCode} ${upstreamRes.statusMessage}\r\n\r\n`);
    });
    proxied.on("error", () => socket.destroy());
    proxied.end();
  }

  private async upstreamHeaders(
    req: http.IncomingMessage,
    target: ConnectionTarget,
    upstream: URL,
  ): Promise<http.OutgoingHttpHeaders> {
    const headers: http.OutgoingHttpHeaders = { ...req.headers };
    delete headers.cookie;
    delete headers.authorization;
    delete headers.dpop;
    headers.host = upstream.host;
    // Requests that reach this point come from the webview, so the server sees its own origin.
    if (headers.origin) headers.origin = upstream.origin;
    if (headers.referer) headers.referer = `${upstream.origin}/`;
    headers.authorization = `Bearer ${await target.bearer()}`;
    return headers;
  }
}

function deny(res: http.ServerResponse): void {
  res.writeHead(403, { "content-type": "text/plain", "cache-control": "no-store" });
  res.end("Forbidden");
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0) out[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return out;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
