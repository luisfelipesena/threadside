import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export interface TraceItem {
  id: string;
  threadId: string;
  type: string;
  status: string;
  runId?: string;
  updatedAt?: string;
  fileName?: string;
  toolName?: string;
  input?: Record<string, unknown>;
  output?: unknown;
  diffStr?: string;
  text?: string;
  changes?: Array<{ path: string }>;
  nativeDriver?: string;
  toolSource?: unknown;
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function traceItem(value: unknown): TraceItem | undefined {
  const row = record(value);
  if (!row || ![row.id, row.threadId, row.type, row.status].every(value => typeof value === "string")) return;
  const string = (key: string) => typeof row[key] === "string" ? row[key] as string : undefined;
  return {
    id: row.id as string, threadId: row.threadId as string, type: row.type as string, status: row.status as string,
    runId: string("runId"), updatedAt: string("updatedAt"), fileName: string("fileName"), toolName: string("toolName"), input: record(row.input),
    output: row.output, diffStr: string("diffStr"), text: string("text"), toolSource: row.toolSource,
    nativeDriver: typeof record(row.nativeItemRef)?.driver === "string" ? record(row.nativeItemRef)!.driver as string : undefined,
    changes: Array.isArray(row.changes) ? row.changes.slice(0, 100).flatMap(value => {
      const path = record(value)?.path;
      return typeof path === "string" ? [{ path }] : [];
    }) : undefined,
  };
}

export function activityPath(item: TraceItem): string | undefined {
  if (item.type === "file_change") return item.fileName;
  // A similarly named MCP tool is not evidence of a local filesystem read.
  if (item.type !== "dynamic_tool" || !/^(read|read_file|view_file)$/i.test(item.toolName ?? "") || item.toolSource) return;
  if (!item.nativeDriver || !["codex", "claudeAgent", "cursor", "antigravity", "grok", "pi", "opencode"].includes(item.nativeDriver)) return;
  const path = item.input?.path ?? item.input?.file_path ?? item.input?.AbsolutePath ?? item.input?.target_file;
  return typeof path === "string" && path.length <= 4096 && !/[\r\n\0]/.test(path) ? path : undefined;
}

export async function resolveTracePath(path: string, root: string): Promise<string | undefined> {
  if (!path || path.length > 4096 || /[\r\n\0]/.test(path)) return;
  try {
    const [base, target] = await Promise.all([realpath(root), realpath(resolve(root, path))]);
    const suffix = relative(base, target);
    if (!suffix || suffix === ".." || suffix.startsWith("..\\") || suffix.startsWith("../") || isAbsolute(suffix)) return;
    return target;
  } catch {
    return undefined;
  }
}

export function failedItem(item: TraceItem): boolean {
  const output = record(item.output);
  return ["failed", "cancelled", "interrupted"].includes(item.status) || output?.isError === true || output?.FileNotFound !== undefined;
}

export type LineSpan = readonly [number, number];
const MAX_LINES = 400;

/** A patch is useful only when its new-side text still matches the displayed document. */
export function patchSpans(diff: string, text: string): LineSpan[] {
  if (diff.length > 256_000 || text.length > 1_000_000) return [];
  const source = diff.split("\n");
  const document = text.split("\n");
  const ranges: LineSpan[] = [];
  for (let i = 0; i < source.length; i++) {
    const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(source[i]!);
    if (!match) continue;
    const start = Number(match[1]) - 1, count = Number(match[2] ?? 1);
    if (count === 0) continue;
    const expected: string[] = [];
    const added: number[] = [];
    for (let j = i + 1; j < source.length && !source[j]!.startsWith("@@"); j++) {
      const line = source[j]!;
      if (/^(diff |--- |\+\+\+ )/.test(line)) break;
      if (line.startsWith("+")) added.push(start + expected.length);
      if (line.startsWith(" ") || line.startsWith("+")) expected.push(line.slice(1));
    }
    if (start < 0 || start + count > document.length || expected.length !== count || expected.some((line, n) => document[start + n]!.replace(/\r$/, "") !== line.replace(/\r$/, ""))) return [];
    for (const line of added.slice(0, MAX_LINES)) {
      const last = ranges.at(-1);
      if (last && last[1] === line - 1) ranges[ranges.length - 1] = [last[0], line];
      else ranges.push([line, line]);
      if (ranges.length === 20) return ranges;
    }
  }
  return ranges;
}

export function readSpans(output: unknown, text: string): LineSpan[] {
  if (text.length > 1_000_000) return [];
  const file = record(record(output)?.file);
  if (!file || typeof file.content !== "string" || typeof file.startLine !== "number" || typeof file.numLines !== "number") return [];
  const start = file.startLine - 1, count = file.numLines;
  const lines = text.split("\n");
  if (!Number.isInteger(start) || !Number.isInteger(count) || start < 0 || count < 1 || start + count > lines.length) return [];
  const actual = lines.slice(start, start + count).join("\n");
  if (actual !== file.content && actual + "\n" !== file.content) return [];
  return [[start, start + Math.min(count, MAX_LINES) - 1]];
}

export function publicInsight(text: string): string | undefined {
  const line = text.split("\n").map(line => line.trim()).find(Boolean);
  if (!line || line.startsWith("```") || /^#{1,6}\s/.test(line)) return;
  return line.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[*`]/g, "").slice(0, 160);
}
