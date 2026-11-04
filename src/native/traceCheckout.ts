import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export interface TraceCheckout {
  root: string;
  gitDirectory: string;
  head: string;
  branch: string;
}

/** Read symbolic HEAD, not its commit: an agent commit on the same branch is not a checkout change. */
export async function traceCheckout(path: string): Promise<TraceCheckout | undefined> {
  try {
    let directory = (await stat(path)).isDirectory() ? path : dirname(path);
    for (let depth = 0; depth < 40; depth++) {
      const marker = join(directory, ".git");
      let entry;
      try { entry = await stat(marker); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
        const parent = dirname(directory);
        if (parent === directory) return;
        directory = parent;
        continue;
      }
      let gitDirectory: string;
      if (entry.isDirectory()) gitDirectory = await realpath(marker);
      else {
        if (!entry.isFile() || entry.size > 4096) return;
        const pointer = /^gitdir: (.+)\r?\n?$/.exec(await readFile(marker, "utf8"));
        if (!pointer) return;
        gitDirectory = await realpath(resolve(directory, pointer[1]!.trim()));
      }
      const headPath = join(gitDirectory, "HEAD");
      if ((await stat(headPath)).size > 4096) return;
      const head = (await readFile(headPath, "utf8")).trim();
      const branch = /^ref: refs\/heads\/([^\r\n]+)$/.exec(head)?.[1];
      if (!branch && !/^[a-f\d]{40,64}$/i.test(head)) return;
      return { root: await realpath(directory), gitDirectory, head, branch: branch ?? `Detached ${head.slice(0, 8)}` };
    }
  } catch { return undefined; }
  return undefined;
}

export function sameCheckout(a: TraceCheckout | undefined, b: TraceCheckout | undefined): boolean {
  return a === undefined ? b === undefined : !!b && a.root === b.root && a.gitDirectory === b.gitDirectory && a.head === b.head;
}
