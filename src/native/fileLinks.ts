import { isAbsolute, normalize, resolve } from "node:path";

export interface FileTarget {
  path: string;
  line?: number;
  column?: number;
  endLine?: number;
}

/**
 * Parses the targets agents write in chat: `src/a.ts`, `src/a.ts:12`, `src/a.ts:12:5`,
 * `src/a.ts#L12`, `src/a.ts#L12-L20`, `src/a.ts#L12C5`, `file:///abs/a.ts#L3`, `~/a.ts`.
 * Relative paths resolve against `baseDir` (the thread's worktree or project root).
 */
export function parseFileHref(href: string, baseDir: string | undefined, home: string): FileTarget | undefined {
  let value = href.trim();
  if (!value) return undefined;
  if (/^file:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      value = decodeURIComponent(url.pathname) + url.hash;
    } catch {
      return undefined;
    }
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    return undefined;
  }

  let line: number | undefined;
  let column: number | undefined;
  let endLine: number | undefined;
  const hash = /#L(\d+)(?:C(\d+))?(?:-L?(\d+)(?:C\d+)?)?$/i.exec(value);
  if (hash) {
    value = value.slice(0, hash.index);
    line = Number(hash[1]);
    column = hash[2] ? Number(hash[2]) : undefined;
    endLine = hash[3] ? Number(hash[3]) : undefined;
  } else {
    value = value.replace(/#.*$/, "");
    const position = /:(\d+)(?::(\d+))?(?:-(\d+))?$/.exec(value);
    if (position) {
      value = value.slice(0, position.index);
      line = Number(position[1]);
      column = position[2] ? Number(position[2]) : undefined;
      endLine = position[3] ? Number(position[3]) : undefined;
    }
  }
  try {
    value = decodeURIComponent(value);
  } catch {
    // keep the raw value
  }
  value = value.replace(/^~(?=\/|$)/, home);
  if (!isAbsolute(value)) {
    if (!baseDir) return undefined;
    value = resolve(baseDir, value);
  }
  return { path: normalize(value), line, column, endLine };
}

/**
 * A composer file chip, in the markdown form T3 Code's own file tree drags: `[math.ts](src/math.ts)`.
 * A line range becomes part of the path and label (`[math.ts:9-11](src/math.ts:9-11)`), because the
 * composer only makes a chip when the label equals the path's basename.
 */
export function mentionFor(path: string, startLine?: number, endLine?: number): string {
  const range = startLine === undefined ? "" : endLine !== undefined && endLine !== startLine ? `:${startLine}-${endLine}` : `:${startLine}`;
  const target = `${path}${range}`;
  const basename = target.slice(Math.max(target.lastIndexOf("/"), target.lastIndexOf("\\")) + 1);
  const label = basename.replace(/([\\[\]])/g, "\\$1");
  const destination = target.replace(/[\s()<>%]/g, (char) => encodeURIComponent(char));
  return `[${label}](${destination})`;
}
