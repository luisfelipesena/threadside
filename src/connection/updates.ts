import type { EnvironmentDescriptor } from "./discovery";

/** T3 Code publishes every build, nightlies included, as a GitHub release; its own updaters read the same list. */
const RELEASES_URL = "https://api.github.com/repos/pingdotgg/t3code/releases?per_page=100";

export interface Release {
  tag_name: string;
  prerelease: boolean;
  draft: boolean;
}

/** `0.1.7` or a nightly such as `0.1.7-nightly.20261102.4080`; a nightly sorts before its release. */
function parse(version: string): number[] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-nightly\.(\d+)\.(\d+))?$/.exec(version.trim());
  if (!match) return undefined;
  const base = [match[1], match[2], match[3]].map(Number);
  return match[4] ? [...base, Number(match[4]), Number(match[5])] : [...base, Infinity, Infinity];
}

export function compareVersions(a: string, b: string): number {
  const left = parse(a) ?? [];
  const right = parse(b) ?? [];
  for (let index = 0; index < 5; index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference) return difference > 0 ? 1 : -1;
  }
  return 0;
}

/** The newest release on the server's channel (nightly or stable) that is newer than `current`. */
export function newerRelease(current: string, releases: readonly Release[]): string | undefined {
  if (!parse(current)) return undefined;
  const nightly = current.includes("-nightly.");
  const versions = releases
    .filter((release) => !release.draft && (nightly ? release.tag_name.includes("-nightly.") : !release.prerelease))
    .map((release) => release.tag_name.replace(/^v/, ""))
    .filter((version) => parse(version));
  const newest = versions.sort(compareVersions).pop();
  return newest && compareVersions(newest, current) > 0 ? newest : undefined;
}

/** Whether the server can install an update itself (`server.updateServerWithProgress`). */
export function canSelfUpdate(descriptor: EnvironmentDescriptor): boolean {
  const method = descriptor.capabilities?.serverSelfUpdate;
  return method === "desktop-managed" || method === "boot-service";
}

/** The release list, revalidated with its ETag so a check that finds nothing new costs no rate limit. */
export class ReleaseFeed {
  private etag: string | undefined;
  private releases: Release[] = [];

  async fetch(): Promise<Release[]> {
    const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "threadside" };
    if (this.etag) headers["if-none-match"] = this.etag;
    const response = await fetch(RELEASES_URL, { headers, signal: AbortSignal.timeout(10_000) });
    if (response.status === 304) return this.releases;
    if (!response.ok) throw new Error(`GitHub answered ${response.status}.`);
    this.releases = (await response.json()) as Release[];
    this.etag = response.headers.get("etag") ?? undefined;
    return this.releases;
  }
}
