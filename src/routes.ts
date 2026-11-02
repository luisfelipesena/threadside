/** Thread routes are `/<environmentId>/<threadId>`; thread ids are UUIDs or prefixed (`mcp:…`). */
export function threadIdFromPath(path: string): string | undefined {
  const match = /^\/([0-9a-f-]{36})\/([^/?#]+)/i.exec(path);
  if (!match?.[2]) return undefined;
  try {
    return decodeURIComponent(match[2]);
  } catch {
    return match[2];
  }
}

export function threadPath(environmentId: string, threadId: string): string {
  return `/${environmentId}/${encodeURIComponent(threadId)}`;
}
