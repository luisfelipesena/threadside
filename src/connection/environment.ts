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

export type ConnectionStatus =
  | { kind: "idle" }
  | { kind: "connecting" }
  | { kind: "connected"; descriptor: EnvironmentDescriptor; httpBaseUrl: string }
  | { kind: "needs-pairing"; reason: string }
  | { kind: "error"; message: string };

const SECRET_PREFIX = "threadside.credential.";
const RENEW_BEFORE_MS = 3 * 24 * 60 * 60 * 1000;

/** Owns the credential, the RPC socket and the shell mirror for one T3 Code environment. */
export class Environment implements vscode.Disposable {
  readonly shell = new ShellStore();
  private rpc: RpcClient | undefined;
  private credential: StoredCredential | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retryDelay = 1000;
  private generation = 0;
  private readonly statusEmitter = new vscode.EventEmitter<ConnectionStatus>();
  readonly onDidChangeStatus = this.statusEmitter.event;
  status: ConnectionStatus = { kind: "idle" };

  constructor(private readonly secrets: vscode.SecretStorage) {}

  get descriptor(): EnvironmentDescriptor | undefined {
    return this.status.kind === "connected" ? this.status.descriptor : undefined;
  }

  get httpBaseUrl(): string | undefined {
    return this.status.kind === "connected" ? this.status.httpBaseUrl : undefined;
  }

  /** The bearer token for the proxy and RPC; never logged or sent to the webview. */
  async bearer(): Promise<string> {
    if (!this.credential) throw new Error("Not connected to T3 Code.");
    return this.credential.token;
  }

  async connect(): Promise<void> {
    const generation = ++this.generation;
    clearTimeout(this.retryTimer);
    this.rpc?.close();
    this.rpc = undefined;
    this.setStatus({ kind: "connecting" });
    try {
      const target = await this.resolveTarget();
      if (!target) {
        this.setStatus({
          kind: "needs-pairing",
          reason: "No T3 Code server runs on this machine. Start T3 Code, or connect to another machine with a pairing link.",
        });
        return;
      }
      const descriptor = await fetchDescriptor(target.httpBaseUrl);
      if (descriptor.orchestrationProtocolVersion !== SUPPORTED_PROTOCOL) {
        throw new Error(
          `This T3 Code server speaks orchestration protocol ${descriptor.orchestrationProtocolVersion}; Threadside supports ${SUPPORTED_PROTOCOL}. Update ${descriptor.orchestrationProtocolVersion > SUPPORTED_PROTOCOL ? "Threadside" : "T3 Code"}.`,
        );
      }
      this.credential = await this.loadCredential(descriptor, target);
      if (!this.credential) {
        this.setStatus({ kind: "needs-pairing", reason: `Pair this editor with ${descriptor.label} to continue.` });
        return;
      }
      await this.openRpc(generation, target.httpBaseUrl, descriptor);
    } catch (error) {
      if (generation !== this.generation) return;
      if (error instanceof UnauthorizedError && this.credential) {
        log().warn("Saved T3 Code credential was rejected; issuing a new one.");
        const environmentId = (this.descriptor ?? (await fetchDescriptor(this.credential.httpBaseUrl).catch(() => undefined)))?.environmentId;
        if (environmentId) await this.secrets.delete(SECRET_PREFIX + environmentId);
        this.credential = undefined;
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
    await this.secrets.store(SECRET_PREFIX + descriptor.environmentId, JSON.stringify(credential));
    await vscode.workspace.getConfiguration("threadside").update("serverUrl", httpBaseUrl, vscode.ConfigurationTarget.Global);
    await this.connect();
  }

  /** Forgets this editor's credential and revokes the session when the local CLI can. */
  async forget(): Promise<void> {
    const descriptor = this.descriptor;
    const credential = this.credential;
    this.disconnect();
    if (descriptor) await this.secrets.delete(SECRET_PREFIX + descriptor.environmentId);
    if (credential?.sessionId && credential.source === "local-cli") {
      const t3Home = resolveT3Home(config().get("t3Home", ""));
      const cli = findCli(t3Home);
      if (cli) await revokeLocalSession(cli, t3Home, credential.sessionId);
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

  private async resolveTarget(): Promise<{ httpBaseUrl: string; local: boolean } | undefined> {
    const configured = config().get<string>("serverUrl", "").trim();
    if (configured) return { httpBaseUrl: configured.replace(/\/+$/, ""), local: false };
    const local = findLocalServer(resolveT3Home(config().get("t3Home", "")));
    return local ? { httpBaseUrl: local.httpBaseUrl, local: true } : undefined;
  }

  private async loadCredential(
    descriptor: EnvironmentDescriptor,
    target: { httpBaseUrl: string; local: boolean },
  ): Promise<StoredCredential | undefined> {
    const key = SECRET_PREFIX + descriptor.environmentId;
    const raw = await this.secrets.get(key);
    let stored = raw ? (JSON.parse(raw) as StoredCredential) : undefined;
    const renewable = target.local && (!stored || stored.source === "local-cli");
    const expiring = stored?.expiresAt !== undefined && stored.expiresAt - Date.now() < RENEW_BEFORE_MS;
    if (renewable && (!stored || expiring)) {
      const t3Home = resolveT3Home(config().get("t3Home", ""));
      const cli = findCli(t3Home);
      if (!cli) {
        if (stored) return { ...stored, httpBaseUrl: target.httpBaseUrl };
        throw new Error("Found a running T3 Code server but not its `t3` command. Open T3 Code once, or pair with a link.");
      }
      const issued = await issueLocalSession(cli, t3Home, clientLabel());
      stored = {
        token: issued.token,
        expiresAt: issued.expiresAt,
        sessionId: issued.sessionId,
        httpBaseUrl: target.httpBaseUrl,
        source: "local-cli",
      };
      await this.secrets.store(key, JSON.stringify(stored));
      log().info(`Issued a T3 Code session for ${descriptor.label}.`);
    }
    if (stored) stored.httpBaseUrl = target.httpBaseUrl;
    return stored;
  }

  private async openRpc(generation: number, httpBaseUrl: string, descriptor: EnvironmentDescriptor): Promise<void> {
    const rpc = new RpcClient(httpBaseUrl, () => this.bearer(), (state, reason) => {
      if (generation !== this.generation || state !== "closed") return;
      log().warn(`T3 Code connection closed (${reason}); reconnecting.`);
      this.setStatus({ kind: "connecting" });
      this.scheduleRetry(generation);
    });
    await rpc.connect();
    if (generation !== this.generation) {
      rpc.close();
      return;
    }
    this.rpc = rpc;
    this.retryDelay = 1000;
    const stream = rpc.stream("orchestration.subscribeShell", {}, (values) => this.shell.apply(values));
    stream.done.catch((error: Error) => log().warn(`Shell stream ended: ${error.message}`));
    this.setStatus({ kind: "connected", descriptor, httpBaseUrl });
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
