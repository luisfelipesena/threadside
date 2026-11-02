import { hostname } from "node:os";
import * as vscode from "vscode";
import { log } from "../log";
import {
  CLIENT_SCOPES,
  type EnvironmentDescriptor,
  fetchDescriptor,
  findCli,
  findLocalServer,
  issueLocalSession,
  resolveT3Home,
  revokeLocalSession,
  SUPPORTED_PROTOCOL,
} from "./discovery";
import { RpcClient, UnauthorizedError } from "./rpc";
import { ShellStore } from "./shell";

interface StoredCredential {
  token: string;
  expiresAt?: number;
  sessionId?: string;
  httpBaseUrl: string;
  source: "local-cli" | "pairing";
}

/** Where the proxy and RPC send requests, with the token issued for exactly that server. */
export interface ConnectionTarget {
  httpBaseUrl: string;
  bearer: () => Promise<string>;
}

export type ConnectionStatus =
  | { kind: "idle" }
  | { kind: "connecting" }
  | { kind: "connected"; descriptor: EnvironmentDescriptor; httpBaseUrl: string; target: ConnectionTarget }
  | { kind: "needs-pairing"; reason: string }
  | { kind: "error"; message: string };

const SECRET_PREFIX = "threadside.credential.";
const RENEW_BEFORE_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_REJECTED = 3;

/**
 * Credentials are keyed by environment id and server origin. The id alone comes from an
 * unauthenticated endpoint, so another server could claim it; the origin pins a token to the server
 * that issued it.
 */
function secretKey(environmentId: string, httpBaseUrl: string): string {
  return `${SECRET_PREFIX}${environmentId}@${new URL(httpBaseUrl).origin}`;
}

/** Owns the credential, the RPC socket and the shell mirror for one T3 Code environment. */
export class Environment implements vscode.Disposable {
  readonly shell = new ShellStore();
  private rpc: RpcClient | undefined;
  private credential: (StoredCredential & { key: string }) | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retryDelay = 1000;
  private generation = 0;
  private rejected = 0;
  private readonly statusEmitter = new vscode.EventEmitter<ConnectionStatus>();
  readonly onDidChangeStatus = this.statusEmitter.event;
  status: ConnectionStatus = { kind: "idle" };

  constructor(private readonly secrets: vscode.SecretStorage) {}

  get descriptor(): EnvironmentDescriptor | undefined {
    return this.status.kind === "connected" ? this.status.descriptor : undefined;
  }

  async connect(): Promise<void> {
    const generation = ++this.generation;
    const stale = () => generation !== this.generation;
    clearTimeout(this.retryTimer);
    this.rpc?.close();
    this.rpc = undefined;
    this.setStatus({ kind: "connecting" });
    let credential: (StoredCredential & { key: string }) | undefined;
    try {
      const target = this.resolveTarget();
      if (!target) {
        this.setStatus({
          kind: "needs-pairing",
          reason: "No T3 Code server runs on this machine. Start T3 Code, or connect to another machine with a pairing link.",
        });
        return;
      }
      const descriptor = await fetchDescriptor(target.httpBaseUrl);
      if (stale()) return;
      if (descriptor.orchestrationProtocolVersion !== SUPPORTED_PROTOCOL) {
        throw new Error(
          `This T3 Code server speaks orchestration protocol ${descriptor.orchestrationProtocolVersion}; Threadside supports ${SUPPORTED_PROTOCOL}. Update ${descriptor.orchestrationProtocolVersion > SUPPORTED_PROTOCOL ? "Threadside" : "T3 Code"}.`,
        );
      }
      credential = await this.loadCredential(descriptor, target);
      if (stale()) return;
      if (!credential) {
        this.setStatus({ kind: "needs-pairing", reason: `Pair this editor with ${descriptor.label} to continue.` });
        return;
      }
      this.credential = credential;
      await this.openRpc(generation, credential, descriptor);
    } catch (error) {
      if (stale()) return;
      if (error instanceof UnauthorizedError && credential) {
        await this.dropRejected(credential);
        if (stale()) return;
        if (++this.rejected >= MAX_REJECTED) {
          this.setStatus({ kind: "error", message: "T3 Code keeps rejecting this editor's session. Run “T3: Connect to T3 Code…”." });
          return;
        }
        log().warn("Saved T3 Code credential was rejected; getting a new one.");
        this.scheduleRetry(generation, 500);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      log().warn(`Connection failed: ${message}`);
      this.setStatus({ kind: "error", message });
      this.scheduleRetry(generation);
    }
  }

  /** Pairs with a server through a pairing link (`https://host/pair#token=…`) or host and code. */
  async pair(link: string): Promise<void> {
    const { httpBaseUrl, code } = parsePairingInput(link);
    const descriptor = await fetchDescriptor(httpBaseUrl);
    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: code,
      subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      scope: CLIENT_SCOPES.join(" "),
      client_label: clientLabel(),
      client_device_type: "desktop",
    });
    const response = await fetch(new URL("/oauth/token", httpBaseUrl), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`Pairing failed (${response.status}). The link may be used or expired; create a new one.`);
    }
    const result = (await response.json()) as { access_token: string; expires_in: number };
    const credential: StoredCredential = {
      token: result.access_token,
      expiresAt: Date.now() + result.expires_in * 1000,
      httpBaseUrl,
      source: "pairing",
    };
    await this.secrets.store(secretKey(descriptor.environmentId, httpBaseUrl), JSON.stringify(credential));
    await vscode.workspace.getConfiguration("threadside").update("serverUrl", httpBaseUrl, vscode.ConfigurationTarget.Global);
    this.rejected = 0;
    await this.connect();
  }

  /** Forgets this editor's credential and revokes the session when the local CLI can. */
  async forget(): Promise<void> {
    const credential = this.credential;
    this.disconnect();
    this.credential = undefined;
    if (credential) {
      await this.secrets.delete(credential.key);
      await this.revoke(credential);
    }
    this.shell.clear();
    this.setStatus({ kind: "needs-pairing", reason: "Disconnected. Connect again to use T3 Code here." });
  }

  disconnect(): void {
    this.generation++;
    clearTimeout(this.retryTimer);
    this.rpc?.close();
    this.rpc = undefined;
  }

  call<T>(tag: string, payload: unknown): Promise<T> {
    if (!this.rpc?.isOpen) return Promise.reject(new Error("Not connected to T3 Code."));
    return this.rpc.call<T>(tag, payload);
  }

  /** Sends an orchestration command such as `thread.settle`. */
  dispatch(command: Record<string, unknown>): Promise<unknown> {
    return this.call("orchestration.dispatchCommand", { commandId: crypto.randomUUID(), ...command });
  }

  private resolveTarget(): { httpBaseUrl: string; local: boolean } | undefined {
    const configured = config().get<string>("serverUrl", "").trim();
    if (configured) return { httpBaseUrl: new URL(configured).origin, local: false };
    const local = findLocalServer(resolveT3Home(config().get("t3Home", "")));
    return local ? { httpBaseUrl: local.httpBaseUrl, local: true } : undefined;
  }

  private async loadCredential(
    descriptor: EnvironmentDescriptor,
    target: { httpBaseUrl: string; local: boolean },
  ): Promise<(StoredCredential & { key: string }) | undefined> {
    const key = secretKey(descriptor.environmentId, target.httpBaseUrl);
    const raw = await this.secrets.get(key);
    let stored = raw ? (JSON.parse(raw) as StoredCredential) : undefined;
    // Never send a token to an origin other than the one it was issued for.
    if (stored && new URL(stored.httpBaseUrl).origin !== new URL(target.httpBaseUrl).origin) stored = undefined;
    const renewable = target.local && (!stored || stored.source === "local-cli");
    const expiring = stored?.expiresAt !== undefined && stored.expiresAt - Date.now() < RENEW_BEFORE_MS;
    if (renewable && (!stored || expiring)) {
      const t3Home = resolveT3Home(config().get("t3Home", ""));
      const cli = findCli(t3Home);
      if (!cli) {
        if (stored) return { ...stored, key };
        throw new Error("Found a running T3 Code server but not its `t3` command. Open T3 Code once, or pair with a link.");
      }
      const previous = stored;
      const issued = await issueLocalSession(cli, t3Home, clientLabel());
      const mine: StoredCredential = {
        token: issued.token,
        expiresAt: issued.expiresAt,
        sessionId: issued.sessionId,
        httpBaseUrl: target.httpBaseUrl,
        source: "local-cli",
      };
      // Windows of one editor share this storage: when another window stored a session while we were
      // issuing ours, use theirs and revoke ours instead of leaving one behind.
      const latest = await this.secrets.get(key);
      if (latest !== raw && latest) {
        await this.revoke(mine);
        stored = JSON.parse(latest) as StoredCredential;
      } else {
        stored = mine;
        await this.secrets.store(key, JSON.stringify(stored));
        if (previous) await this.revoke(previous);
        log().info(`Issued a T3 Code session for ${descriptor.label}.`);
      }
    }
    return stored ? { ...stored, key } : undefined;
  }

  private async dropRejected(credential: StoredCredential & { key: string }): Promise<void> {
    await this.secrets.delete(credential.key);
    await this.revoke(credential);
    if (this.credential?.key === credential.key) this.credential = undefined;
  }

  private async revoke(credential: StoredCredential): Promise<void> {
    if (credential.source !== "local-cli" || !credential.sessionId) return;
    const t3Home = resolveT3Home(config().get("t3Home", ""));
    const cli = findCli(t3Home);
    if (cli) await revokeLocalSession(cli, t3Home, credential.sessionId);
  }

  private async openRpc(generation: number, credential: StoredCredential, descriptor: EnvironmentDescriptor): Promise<void> {
    const token = credential.token;
    const target: ConnectionTarget = { httpBaseUrl: credential.httpBaseUrl, bearer: async () => token };
    const reconnect = (reason: string) => {
      if (generation !== this.generation) return;
      log().warn(`T3 Code connection lost (${reason}); reconnecting.`);
      this.rpc?.close();
      this.setStatus({ kind: "connecting" });
      this.scheduleRetry(generation);
    };
    const rpc = new RpcClient(target.httpBaseUrl, target.bearer, (state, reason) => {
      if (state === "closed") reconnect(reason ?? "closed");
    });
    await rpc.connect();
    if (generation !== this.generation) {
      rpc.close();
      return;
    }
    this.rpc = rpc;
    this.retryDelay = 1000;
    this.rejected = 0;
    const stream = rpc.stream("orchestration.subscribeShell", {}, (values) => this.shell.apply(values));
    // The thread list must not freeze while the socket stays open: a finished stream reconnects.
    stream.done.then(
      () => reconnect("thread stream ended"),
      (error: Error) => reconnect(error.message),
    );
    this.setStatus({ kind: "connected", descriptor, httpBaseUrl: target.httpBaseUrl, target });
    log().info(`Connected to ${descriptor.label} (T3 Code ${descriptor.serverVersion}).`);
  }

  private scheduleRetry(generation: number, delay = this.retryDelay): void {
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      if (generation === this.generation) void this.connect();
    }, delay);
    this.retryDelay = Math.min(this.retryDelay * 2, 30_000);
  }

  private setStatus(status: ConnectionStatus): void {
    this.status = status;
    void vscode.commands.executeCommand("setContext", "threadside.connected", status.kind === "connected");
    this.statusEmitter.fire(status);
  }

  dispose(): void {
    this.disconnect();
    this.shell.dispose();
    this.statusEmitter.dispose();
  }
}

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("threadside");
}

/** How this editor shows up in T3 Code's Settings → Sharing & access. */
function clientLabel(): string {
  const remote = vscode.env.remoteName ? ` via ${vscode.env.remoteName}` : "";
  return `Threadside in ${vscode.env.appName}${remote} (${hostname().replace(/\.local$/, "")})`;
}

export function parsePairingInput(input: string): { httpBaseUrl: string; code: string } {
  const trimmed = input.trim();
  const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
  const hash = new URLSearchParams(url.hash.replace(/^#/, ""));
  const code = hash.get("token") ?? url.searchParams.get("token") ?? url.searchParams.get("code");
  if (!code) throw new Error("The pairing link has no token. Copy the whole link from T3 Code or `t3 pair`.");
  if (url.protocol === "t3code:") {
    const host = url.searchParams.get("host") ?? url.searchParams.get("url");
    if (!host) throw new Error("This t3code:// link has no server address.");
    return { httpBaseUrl: new URL(host).origin, code };
  }
  return { httpBaseUrl: url.origin, code };
}
