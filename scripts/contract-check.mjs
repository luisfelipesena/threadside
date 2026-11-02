#!/usr/bin/env node
// Checks that a T3 Code server still offers everything Threadside depends on.
// Usage: T3_URL=http://127.0.0.1:3773 T3_TOKEN=<bearer> node scripts/contract-check.mjs
// Without T3_TOKEN it issues a short-lived token with the local `t3` CLI (T3_CLI, default `t3`).
import { execFileSync } from "node:child_process";

const base = (process.env.T3_URL ?? "http://127.0.0.1:3773").replace(/\/+$/, "");
const failures = [];
const check = (ok, label) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) failures.push(label);
};

function token() {
  if (process.env.T3_TOKEN) return process.env.T3_TOKEN;
  const cli = process.env.T3_CLI ?? "t3";
  const out = execFileSync(cli, ["auth", "session", "issue", "--json", "--ttl", "10m", "--label", "threadside contract check", "--scope", "orchestration:read"], {
    encoding: "utf8",
  });
  return JSON.parse(out.slice(out.indexOf("{"))).token;
}

const descriptor = await (await fetch(`${base}/.well-known/t3/environment`)).json();
check(descriptor.orchestrationProtocolVersion === 2, `orchestration protocol is 2 (server ${descriptor.serverVersion})`);

const bearer = token();
const session = await (await fetch(`${base}/api/auth/session`, { headers: { authorization: `Bearer ${bearer}` } })).json();
check(session.authenticated === true, "bearer tokens authenticate HTTP requests");

const ticketResponse = await fetch(`${base}/api/auth/websocket-ticket`, { method: "POST", headers: { authorization: `Bearer ${bearer}` } });
const { ticket } = await ticketResponse.json();
check(ticketResponse.ok && typeof ticket === "string", "bearer tokens get WebSocket tickets");

const shell = await new Promise((resolve) => {
  const url = new URL("/ws", base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("orchestrationProtocol", "2");
  url.searchParams.set("clientSurface", "web");
  url.searchParams.set("wsTicket", ticket);
  const socket = new WebSocket(url);
  const timer = setTimeout(() => {
    socket.close();
    resolve(undefined);
  }, 15_000);
  socket.onopen = () => socket.send(JSON.stringify({ _tag: "Request", id: "1", tag: "orchestration.subscribeShell", payload: {}, headers: [] }));
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    if (message._tag !== "Chunk") return;
    const snapshot = message.values.find((value) => value.kind === "snapshot")?.snapshot;
    if (!snapshot) return;
    clearTimeout(timer);
    socket.close();
    resolve(snapshot);
  };
  socket.onerror = () => resolve(undefined);
});
check(Boolean(shell), "orchestration.subscribeShell streams a snapshot");
if (shell) {
  check(Array.isArray(shell.threads) && Array.isArray(shell.projects), "snapshot has threads and projects");
  const thread = shell.threads[0];
  const fields = ["id", "projectId", "title", "status", "worktreePath", "branch", "lineage", "settledAt", "snoozedUntil", "pinnedAt", "updatedAt"];
  if (thread) check(fields.every((field) => field in thread), `thread shells carry ${fields.join(", ")}`);
  const project = shell.projects[0];
  if (project) check(["id", "title", "workspaceRoot"].every((field) => field in project), "project shells carry id, title, workspaceRoot");
}

// The bridge hooks into these parts of the web app; a rename upstream shows up here first.
const html = await (await fetch(`${base}/`)).text();
check(/<head[^>]*>/i.test(html), "the web app serves an HTML document with <head>");
const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+\.js)"/g)].map((match) => match[1]);
let bundle = "";
const seen = new Set();
const queue = [...assets];
while (queue.length && seen.size < 400) {
  const path = queue.shift();
  if (seen.has(path)) continue;
  seen.add(path);
  const source = await (await fetch(`${base}${path}`)).text();
  bundle += source;
  for (const match of source.matchAll(/["'`(]\.?\/?((?:assets\/)?[\w.-]+\.js)["'`)]/g)) {
    const next = match[1].startsWith("assets/") ? `/${match[1]}` : `/assets/${match[1]}`;
    if (!seen.has(next)) queue.push(next);
  }
}
for (const marker of ["composer-editor", "chat-markdown-file-link", "application/x-t3code-composer-mention", "Expand composer", "prefers-color-scheme"]) {
  check(bundle.includes(marker), `web bundle still contains "${marker}"`);
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed against T3 Code ${descriptor.serverVersion}.`);
  process.exit(1);
}
console.log(`\nAll checks passed against T3 Code ${descriptor.serverVersion}.`);
