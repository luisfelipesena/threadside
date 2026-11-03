export interface Position {
  line: number;
  column: number;
}

export interface Problem {
  severity: "error" | "warning";
  line: number;
  column: number;
  message: string;
  source?: string;
  code?: string;
}

/** What the editor shows, with 1-based lines and columns. */
export interface EditorSnapshot {
  ide: string;
  file: string;
  language: string;
  cursor: Position;
  selection?: { start: Position; end: Position };
  visible?: { start: number; end: number };
  dirty: boolean;
  openFiles: string[];
  problems: Problem[];
  otherProblems: Array<{ file: string; errors: number; warnings: number }>;
}

export interface IdeContext {
  /** Names the chip; T3 Code files the payload under "terminal" and adds its line range. */
  label: string;
  text: string;
  lines: number;
}

const MAX_PROBLEMS = 30;
const MAX_FILES = 12;

/**
 * The editor state an agent needs to answer "what is wrong here": the focused file, where the cursor
 * and selection are, what is on screen, the other open files and the Problems the editor shows.
 */
export function ideContext(snapshot: EditorSnapshot): IdeContext {
  const errors = snapshot.problems.filter((problem) => problem.severity === "error").length;
  const warnings = snapshot.problems.length - errors;
  const where = snapshot.selection
    ? `lines ${snapshot.selection.start.line}-${snapshot.selection.end.line} selected`
    : `cursor at line ${snapshot.cursor.line}, column ${snapshot.cursor.column}`;
  const lines = [
    `State of the user's editor (${snapshot.ide}) when this message was sent. It is not terminal output.`,
    `Focused file: ${snapshot.file} (${snapshot.language}), ${where}${snapshot.dirty ? ", unsaved changes not yet on disk" : ""}`,
  ];
  if (snapshot.visible) lines.push(`On screen: lines ${snapshot.visible.start}-${snapshot.visible.end}`);
  const others = snapshot.openFiles.filter((file) => file !== snapshot.file);
  if (others.length) lines.push(`Other open files: ${others.slice(0, MAX_FILES).join(", ")}${others.length > MAX_FILES ? `, and ${others.length - MAX_FILES} more` : ""}`);
  lines.push(`Problems in the focused file: ${snapshot.problems.length ? count(errors, warnings) : "none"}`);
  const sorted = [...snapshot.problems].sort((a, b) => rank(a) - rank(b) || a.line - b.line || a.column - b.column);
  for (const problem of sorted.slice(0, MAX_PROBLEMS)) lines.push(`  ${problemLine(problem)}`);
  if (sorted.length > MAX_PROBLEMS) lines.push(`  and ${sorted.length - MAX_PROBLEMS} more`);
  const elsewhere = snapshot.otherProblems.filter((entry) => entry.errors + entry.warnings > 0);
  if (elsewhere.length) lines.push(`Problems in other open files: ${elsewhere.slice(0, MAX_FILES).map((entry) => `${entry.file} (${count(entry.errors, entry.warnings)})`).join(", ")}`);

  const name = snapshot.file.split(/[\\/]/).pop() || snapshot.file;
  const line = snapshot.selection ? `${snapshot.selection.start.line}-${snapshot.selection.end.line}` : String(snapshot.cursor.line);
  const label = `${snapshot.ide} editor (${name}:${line}${snapshot.problems.length ? `, ${errors ? plural(errors, "error") : plural(warnings, "warning")}` : ""})`;
  return { label: label.replace(/[[\]\\\r\n]/g, " "), text: lines.join("\n"), lines: lines.length };
}

function problemLine(problem: Problem): string {
  const origin = [problem.source, problem.code].filter(Boolean).join(" ");
  const message = problem.message.split("\n")[0]!.slice(0, 300);
  return `${problem.severity} ${problem.line}:${problem.column} ${message}${origin ? ` (${origin})` : ""}`;
}

function rank(problem: Problem): number {
  return problem.severity === "error" ? 0 : 1;
}

function count(errors: number, warnings: number): string {
  return [errors && plural(errors, "error"), warnings && plural(warnings, "warning")].filter(Boolean).join(", ");
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
