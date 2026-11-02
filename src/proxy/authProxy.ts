import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import type { AddressInfo, Socket } from "node:net";
import { log, redact } from "../log";
import { BRIDGE_PATH, injectBridge, upstreamUrl } from "./upstream";

const KEY_COOKIE = "threadside_key";
const KEY_PARAM = "threadside_key";
const THEME_PARAM = "threadside_theme";

export interface ProxyTarget {
  httpBaseUrl: string;
  bearer: () => Promise<string>;
}

/**
 * Serves the connected T3 Code server's own web build on loopback and adds the bearer token on the
 * way out, so the chat UI is always the exact version the server ships. The webview loads this
 * origin in an iframe. Each window gets a random key; requests without it are refused, so other
 * local processes cannot ride the forwarded port.
 */
export class AuthProxy {
  private server: http.Server | undefined;
  private readonly key = randomBytes(24).toString("base64url");
  private target: ProxyTarget | undefined;
  private bridgeSource: string;

  constructor(bridgeFile: string) {
    this.bridgeSource = readFileSync(bridgeFile, "utf8");
  }

  setTarget(target: ProxyTarget | undefined): void {
    this.target = target;
  }

  /** Starts on the preferred port when free, so the iframe origin (and its saved UI state) is stable. */
  async start(preferredPort: number | undefined): Promise<number> {
    if (this.server) return (this.server.address() as AddressInfo).port;
    const server = http.createServer((req, res) => void this.handle(req, res));
    server.on("upgrade", (req, socket, head) => void this.upgrade(req, socket as Socket, head));
    server.keepAliveTimeout = 30_000;
    const listen = (port: number) =>
      new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          server.off("error", reject);
          resolve((server.address() as AddressInfo).port);
        });
      });
    let port: number;
    try {
      port = await listen(preferredPort ?? 0);
    } catch {
      port = await listen(0);
    }
    this.server = server;
    return port;
  }

  /** The entry URL; its one-time parameter sets the key cookie and is stripped by a redirect. */
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

  private authorized(req: http.IncomingMessage): boolean {
    const cookie = parseCookies(req.headers.cookie)[KEY_COOKIE];
    return cookie !== undefined && safeEqual(cookie, this.key);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://proxy.invalid");
    const presented = url.searchParams.get(KEY_PARAM);
    if (presented !== null) {
      if (!safeEqual(presented, this.key)) return deny(res);
      const theme = url.searchParams.get(THEME_PARAM) === "light" ? "light" : "dark";
      url.searchParams.delete(KEY_PARAM);
      url.searchParams.delete(THEME_PARAM);
      res.writeHead(302, {
        location: url.pathname + url.search + url.hash,
        "set-cookie": [
          `${KEY_COOKIE}=${this.key}; Path=/; HttpOnly; SameSite=None; Secure`,
          // Read by the bridge before the app starts, so the first paint already matches the editor.
          `${THEME_PARAM}=${theme}; Path=/; SameSite=None; Secure`,
        ],
        "cache-control": "no-store",
      });
      res.end();
      return;
    }
    if (!this.authorized(req)) return deny(res);
    if (url.pathname === BRIDGE_PATH) {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
      res.end(this.bridgeSource);
      return;
    }
    const target = this.target;
    if (!target) {
      res.writeHead(503, { "content-type": "text/plain" });
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
    if (!this.authorized(req) || !target) {
      socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
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
      upstreamSocket.on("error", close);
    });
    proxied.on("response", (upstreamRes) => {
      socket.end(`HTTP/1.1 ${upstreamRes.statusCode} ${upstreamRes.statusMessage}\r\n\r\n`);
    });
    proxied.on("error", () => socket.destroy());
    proxied.end();
  }

  private async upstreamHeaders(
    req: http.IncomingMessage,
    target: ProxyTarget,
    upstream: URL,
  ): Promise<http.OutgoingHttpHeaders> {
    const headers: http.OutgoingHttpHeaders = { ...req.headers };
    delete headers.cookie;
    delete headers.authorization;
    delete headers.dpop;
    headers.host = upstream.host;
    if (headers.origin) headers.origin = upstream.origin;
    if (headers.referer) headers.referer = upstream.origin + "/";
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
