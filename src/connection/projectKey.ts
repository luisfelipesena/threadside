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
