import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/** The environment descriptor every T3 Code server publishes at `/.well-known/t3/environment`. */
export interface EnvironmentDescriptor {
  environmentId: string;
  label: string;
  serverVersion: string;
  orchestrationProtocolVersion: number;
  platform?: { os?: string; arch?: string };
  capabilities?: Record<string, unknown>;
}

export interface LocalServer {
  httpBaseUrl: string;
  serverVersion: string | undefined;
  t3Home: string;
}

export const SUPPORTED_PROTOCOL = 2;

export function resolveT3Home(configured: string): string {
  if (configured.trim()) return configured.trim().replace(/^~(?=$|\/)/, homedir());
  return process.env.T3CODE_HOME?.trim() || join(homedir(), ".t3");
}

function pidAlive(pid: unknown): boolean {
  if (typeof pid !== "number" || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Reads the runtime file the T3 Code server writes on start, so a local server needs no setup. */
export function findLocalServer(t3Home: string): LocalServer | undefined {
  const file = join(t3Home, "userdata", "server-runtime.json");
  if (!existsSync(file)) return undefined;
  try {
    const runtime = JSON.parse(readFileSync(file, "utf8")) as {
      port?: number;
      origin?: string;
      pid?: number;
      serverVersion?: string;
    };
    if (!pidAlive(runtime.pid) || typeof runtime.port !== "number") return undefined;
    return {
      httpBaseUrl: `http://127.0.0.1:${runtime.port}`,
      serverVersion: runtime.serverVersion,
      t3Home,
    };
  } catch {
    return undefined;
  }
}

export async function fetchDescriptor(httpBaseUrl: string, timeoutMs = 4000): Promise<EnvironmentDescriptor> {
  const response = await fetch(new URL("/.well-known/t3/environment", httpBaseUrl), {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`T3 Code server at ${httpBaseUrl} answered ${response.status}.`);
  return (await response.json()) as EnvironmentDescriptor;
}

/** The `t3` CLI the desktop app installs, then any `t3` on PATH. */
export function findCli(t3Home: string): string | undefined {
  const names = process.platform === "win32" ? ["t3.cmd", "t3.exe", "t3.ps1"] : ["t3"];
  const candidates = [process.env.T3CODE_CLI_PATH, ...names.map((name) => join(t3Home, "bin", name))];
  for (const candidate of candidates) if (candidate && existsSync(candidate)) return candidate;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    for (const name of names) if (dir && existsSync(join(dir, name))) return join(dir, name);
  }
  return undefined;
}

export interface IssuedSession {
  token: string;
  expiresAt: number | undefined;
  sessionId: string | undefined;
}

/** Scopes a chat client needs; access management and relay control stay with the user's other devices. */
export const CLIENT_SCOPES = [
  "orchestration:read",
  "orchestration:operate",
  "settings:write",
  "providers:manage",
  "preview:operate",
  "diagnostics:read",
  "terminal:read",
  "terminal:operate",
  "source-control:write",
  "filesystem:read",
  "filesystem:write",
] as const;

export function revokeLocalSession(cli: string, t3Home: string, sessionId: string): Promise<void> {
  return new Promise((resolve) => {
    execFile(cli, ["auth", "session", "revoke", sessionId], { env: { ...process.env, T3CODE_HOME: t3Home }, timeout: 30_000 }, () =>
      resolve(),
    );
  });
}

export function issueLocalSession(cli: string, t3Home: string, label: string): Promise<IssuedSession> {
  const args = ["auth", "session", "issue", "--json", "--ttl", "30d", "--label", label];
  for (const scope of CLIENT_SCOPES) args.push("--scope", scope);
  return new Promise((resolve, reject) => {
    execFile(
      cli,
      args,
      { env: { ...process.env, T3CODE_HOME: t3Home }, timeout: 30_000, maxBuffer: 1 << 20 },
      (error, stdout) => {
        if (error) {
          reject(new Error(`t3 auth session issue failed: ${error.message.split("\n")[0]}`));
          return;
        }
        try {
          resolve(parseIssued(stdout));
        } catch (cause) {
          reject(cause);
        }
      },
    );
  });
}

export function parseIssued(stdout: string): IssuedSession {
  const start = stdout.indexOf("{");
  if (start < 0) throw new Error("t3 auth session issue printed no JSON.");
  const json = JSON.parse(stdout.slice(start)) as Record<string, unknown>;
  const token = [json.token, json.accessToken, json.access_token, json.bearerToken].find(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  if (!token) throw new Error("t3 auth session issue returned no token.");
  const expires = json.expiresAt ?? json.expires_at;
  const expiresAt = typeof expires === "string" ? Date.parse(expires) : typeof expires === "number" ? expires : undefined;
  return {
    token,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : undefined,
    sessionId: typeof json.sessionId === "string" ? json.sessionId : undefined,
  };
}
