import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import ts from "typescript";
import type { AITrace, TraceHost } from "../src/native/aiTrace";
import * as activity from "../src/native/traceActivity.ts";
import * as checkout from "../src/native/traceCheckout.ts";

const require = createRequire(`${process.cwd()}/package.json`);
const key = { environmentId: "host-A", threadId: "thread-A" };

function harness(local = true) {
  const events = new Map<string, (value: unknown) => void>();
  const timers = new Map<number, () => void>();
  let nextTimer = 0, subscriptions = 0, cancellations = 0;
  let receive: (values: unknown[]) => void = () => {};
  let selected = { key, visible: true };
  const environment = {
    descriptor: { environmentId: key.environmentId }, ownsWorkspaceFiles: local,
    status: { kind: "connected" }, shell: { threads: new Map(), projects: new Map([["project", { workspaceRoot: "/repo" }]]), onDidChange: event("shell") },
    subscribe: (_tag: string, _payload: unknown, callback: typeof receive) => {
      subscriptions++; receive = callback;
      return { done: new Promise(() => {}), cancel: () => cancellations++ };
    },
  };
  function event(name: string) { return (callback: (value: unknown) => void) => { events.set(name, callback); return { dispose: () => events.delete(name) }; }; }
  const editor = { document: { isClosed: false, uri: { toString: () => "file:///human.ts" } }, viewColumn: 1 };
  const group = { viewColumn: 1, tabs: [] };
  const vscode = {
    window: { state: { focused: true }, tabGroups: { all: [group] },
      onDidChangeActiveTextEditor: event("editor"), onDidChangeTextEditorSelection: event("selection"), onDidChangeTextEditorVisibleRanges: event("scroll"), onDidChangeWindowState: event("window") },
    workspace: { onDidChangeTextDocument: event("document") },
    TextEditorSelectionChangeKind: { Mouse: 2, Keyboard: 1 },
  };
  const source = ts.transpileModule(readFileSync("src/native/aiTrace.ts", "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const exports: Record<string, unknown> = {};
  new Function("require", "exports", "setTimeout", "clearTimeout", source)(
    (name: string) => name === "vscode" ? vscode : name === "./traceActivity" ? activity : name === "./traceCheckout" ? checkout : require(name), exports,
    (callback: () => void) => { const id = ++nextTimer; timers.set(id, callback); return id; },
    (id: number) => timers.delete(id),
  );
  const Constructor = exports.AITrace as new (host: TraceHost) => AITrace;
  const trace = new Constructor({ environment, selected: () => selected, editor: () => editor, capture: () => undefined, toUri: () => {}, changed: () => {} } as unknown as TraceHost);
  const snapshot = (items: unknown[] = []) => receive([{ kind: "snapshot", snapshotSequence: 10, projection: { thread: { id: key.threadId, projectId: "project", title: "Task A" }, turnItems: items } }]);
  const item = { id: "item", threadId: key.threadId, type: "file_change", status: "running", fileName: "/repo/a.ts" };
  return { trace, events, timers, environment, vscode, editor, snapshot, item,
    receive: (values: unknown[]) => receive(values), select: (threadId: string, visible = true) => { selected = { key: { ...key, threadId }, visible }; trace.selectionChanged(); },
    counts: () => ({ subscriptions, cancellations, listeners: events.size, timers: timers.size }),
  };
}

test("off is inert: no stream, timer, editor listener or decoration", () => {
  const h = harness();
  assert.equal(h.trace.view(key).enabled, false);
  h.trace.selectionChanged();
  h.trace.connectionChanged();
  assert.deepEqual(h.counts(), { subscriptions: 0, cancellations: 0, listeners: 0, timers: 0 });
  h.trace.dispose();
});

test("paired remote environments cannot drive local files", () => {
  const h = harness(false);
  h.trace.toggle(key);
  assert.equal(h.trace.view(key).available, false);
  assert.equal(h.counts().subscriptions, 0);
});

test("completed snapshots are history, while one running item schedules current activity", () => {
  const h = harness(); h.trace.toggle(key);
  h.snapshot([{ ...h.item, status: "completed" }]);
  assert.equal(h.timers.size, 0);
  h.snapshot([h.item]);
  assert.equal(h.timers.size, 1);
  h.trace.stop();
  assert.equal(h.timers.size, 0);
  assert.equal(h.counts().cancellations, 1);
  h.trace.dispose();
});

test("foreign threads, duplicate sequences and hidden selection do not schedule navigation", () => {
  const h = harness(); h.trace.toggle(key); h.snapshot();
  h.receive([{ kind: "event", sequence: 11, event: { type: "turn-item.updated", payload: { ...h.item, threadId: "B" } } }]);
  h.receive([{ kind: "event", sequence: 10, event: { type: "turn-item.updated", payload: h.item } }]);
  assert.equal(h.timers.size, 0);
  h.select("B");
  assert.equal(h.trace.view({ ...key, threadId: "B" }).paused, true);
  assert.equal(h.trace.view({ ...key, threadId: "B" }).available, false);
  h.receive([{ kind: "event", sequence: 12, event: { type: "turn-item.updated", payload: h.item } }]);
  assert.equal(h.timers.size, 0);
  h.select(key.threadId);
  h.snapshot();
  h.receive([{ kind: "event", sequence: 13, event: { type: "turn-item.updated", payload: h.item } }]);
  assert.equal(h.timers.size, 1);
  h.trace.dispose();
});

test("manual selection pauses the view without cancelling the agent or subscription", () => {
  const h = harness(); h.trace.toggle(key); h.snapshot();
  h.events.get("selection")!({ kind: 2, textEditor: h.editor });
  assert.equal(h.trace.view(key).paused, true);
  assert.equal(h.counts().cancellations, 0);
  h.trace.resume(key);
  assert.equal(h.trace.view(key).paused, false);
  h.trace.dispose();
});

test("reconnect uses a fresh snapshot and switching servers turns following off", () => {
  const h = harness(); h.trace.toggle(key); h.snapshot([h.item]);
  h.environment.status.kind = "error"; h.trace.connectionChanged();
  assert.equal(h.timers.size, 0);
  assert.equal(h.trace.view(key).paused, true);
  h.environment.status.kind = "connected"; h.trace.connectionChanged();
  assert.equal(h.counts().subscriptions, 2);
  h.environment.descriptor.environmentId = "host-B"; h.trace.connectionChanged();
  assert.equal(h.trace.view(key).enabled, false);
  h.trace.dispose();
});

test("late events after disabling cannot restart following", () => {
  const h = harness(); h.trace.toggle(key); h.snapshot(); h.trace.stop();
  h.receive([{ kind: "event", sequence: 100, event: { type: "turn-item.updated", payload: h.item } }]);
  assert.equal(h.timers.size, 0);
  assert.equal(h.trace.view(key).enabled, false);
  h.trace.dispose();
});

test("unknown future events advance the cursor without replaying older activity", () => {
  const h = harness(); h.trace.toggle(key); h.snapshot();
  h.receive([{ kind: "unknown-event", sequence: 100, eventType: "future-event" }]);
  h.receive([{ kind: "event", sequence: 99, event: { type: "turn-item.updated", payload: h.item } }]);
  assert.equal(h.timers.size, 0);
  h.trace.dispose();
});

test("waiting for permission never navigates to the proposed target", () => {
  const h = harness(); h.trace.toggle(key); h.snapshot();
  h.receive([{ kind: "event", sequence: 11, event: { type: "turn-item.updated", payload: { ...h.item, status: "waiting" } } }]);
  assert.equal(h.timers.size, 0);
  assert.match(h.trace.view(key).detail, /Waiting/);
  h.trace.dispose();
});

test("switching away and back starts fresh instead of applying old in-flight events", () => {
  const h = harness(); h.trace.toggle(key); h.snapshot([h.item]);
  h.select("B");
  assert.equal(h.counts().cancellations, 1);
  assert.equal(h.timers.size, 0);
  h.select(key.threadId);
  assert.equal(h.counts().subscriptions, 2);
  h.snapshot([{ ...h.item, status: "completed" }]);
  assert.equal(h.timers.size, 0);
  h.trace.dispose();
});

test("project metadata arriving after the thread snapshot recovers without a user retry", () => {
  const h = harness(); h.environment.shell.projects.clear(); h.trace.toggle(key); h.snapshot([h.item]);
  assert.equal(h.timers.size, 0);
  assert.match(h.trace.view(key).detail, /Waiting for the thread/);
  h.environment.shell.projects.set("project", { workspaceRoot: "/repo" });
  h.events.get("shell")!(new Set());
  assert.equal(h.counts().subscriptions, 2);
  h.trace.dispose();
});

test("live approvals block reveals until resolved, including pending work", () => {
  const h = harness(); h.trace.toggle(key); h.snapshot();
  h.receive([{ kind: "event", sequence: 11, event: { type: "runtime-request.updated", payload: { id: "request", status: "pending", responseCapability: { type: "live" } } } }]);
  h.receive([{ kind: "event", sequence: 12, event: { type: "turn-item.updated", payload: h.item } }]);
  assert.equal(h.timers.size, 0);
  assert.match(h.trace.view(key).detail, /Waiting for your response/);
  h.receive([{ kind: "event", sequence: 13, event: { type: "runtime-request.updated", payload: { id: "request", status: "resolved", responseCapability: { type: "live" } } } }]);
  h.receive([{ kind: "event", sequence: 14, event: { type: "turn-item.updated", payload: h.item } }]);
  assert.equal(h.timers.size, 1);
  h.trace.dispose();
});

test("asynchronous questions do not freeze an agent that is still working", () => {
  const h = harness(); h.trace.toggle(key); h.snapshot();
  h.receive([{ kind: "event", sequence: 11, event: { type: "runtime-request.updated", payload: { id: "request", status: "pending", responseCapability: { type: "message" } } } }]);
  h.receive([{ kind: "event", sequence: 12, event: { type: "turn-item.updated", payload: h.item } }]);
  assert.equal(h.timers.size, 1);
  h.trace.dispose();
});
