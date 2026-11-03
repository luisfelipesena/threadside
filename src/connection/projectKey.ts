export interface KeyedProject {
  workspaceRoot: string;
  repositoryIdentity?: { canonicalKey: string; origin?: { canonicalKey?: string } | null } | null;
}

/**
 * The key T3 Code's thread list filters a project by, in its default grouping by repository: the
 * repository's canonical key, else the environment and folder (`deriveLogicalProjectKey` upstream).
 */
export function sidebarProjectKey(project: KeyedProject, environmentId: string): string {
  const identity = project.repositoryIdentity;
  const key = identity ? (identity.origin?.canonicalKey ?? identity.canonicalKey) : undefined;
  if (key && !key.includes("\0")) return key;
  let root = project.workspaceRoot.trim().replace(/[\\/]+$/, "") || project.workspaceRoot.trim();
  if (/^[A-Za-z]:[\\/]|^\\\\/.test(root)) root = root.replaceAll("/", "\\").toLowerCase();
  return `${environmentId}:${root}`;
}

/**
 * The tag T3 Code gives a thread's notification (`BT` upstream): a 64-bit FNV-1a hash of
 * `environmentId:threadId` over UTF-16 code units, as 16 hex digits.
 */
export function notificationTag(environmentId: string, threadId: string): string {
  const text = `${environmentId}:${threadId}`;
  let hash = 14695981039346656037n;
  for (let index = 0; index < text.length; index++) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = (hash * 1099511628211n) & 18446744073709551615n;
  }
  return hash.toString(16).padStart(16, "0");
}
