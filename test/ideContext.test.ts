import assert from "node:assert/strict";
import { test } from "node:test";
import { ideContext, type EditorSnapshot } from "../src/native/ideContext.ts";

const base: EditorSnapshot = {
  ide: "Cursor",
  file: "/code/nemo/dcoya/logger.py",
  language: "python",
  cursor: { line: 158, column: 9 },
  visible: { start: 117, end: 195 },
  dirty: false,
  openFiles: ["/code/nemo/dcoya/logger.py", "/code/nemo/factory.py"],
  problems: [],
  otherProblems: [],
};

test("the chip names the file, line and error count; the payload lists the problems, errors first", () => {
  const context = ideContext({
    ...base,
    dirty: true,
    problems: [
      { severity: "warning", line: 140, column: 1, message: "Unused import", source: "Pylance", code: "reportUnusedImport" },
      { severity: "error", line: 152, column: 17, message: 'Argument of type "str" is not assignable\nmore detail', source: "Pylance" },
    ],
    otherProblems: [{ file: "/code/nemo/factory.py", errors: 2, warnings: 0 }],
  });
  assert.equal(context.label, "Cursor editor (logger.py:158, 1 error)");
  const lines = context.text.split("\n");
  assert.equal(context.lines, lines.length);
  assert.match(lines[1]!, /Focused file: \/code\/nemo\/dcoya\/logger\.py \(python\), cursor at line 158, column 9, unsaved changes/);
  assert.ok(lines.includes("Other open files: /code/nemo/factory.py"));
  assert.ok(lines.includes("Problems in the focused file: 1 error, 1 warning"));
  const first = lines.findIndex((line) => line.startsWith("  "));
  assert.equal(lines[first], '  error 152:17 Argument of type "str" is not assignable (Pylance)');
  assert.equal(lines[first + 1], "  warning 140:1 Unused import (Pylance reportUnusedImport)");
  assert.ok(lines.includes("Problems in other open files: /code/nemo/factory.py (2 errors)"));
});

test("a clean file with a selection says so and keeps the chip short", () => {
  const context = ideContext({ ...base, selection: { start: { line: 141, column: 1 }, end: { line: 155, column: 20 } } });
  assert.equal(context.label, "Cursor editor (logger.py:141-155)");
  assert.match(context.text, /lines 141-155 selected/);
  assert.match(context.text, /Problems in the focused file: none/);
  assert.doesNotMatch(context.text, /unsaved/);
});
