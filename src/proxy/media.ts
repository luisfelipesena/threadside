import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import type * as http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { log } from "../log";

/**
 * Editor webviews decode less than T3 Code's desktop app: VS Code's media library has H.264, MP3,
 * FLAC and Vorbis but no AAC, HEVC, Opus or WebM reader, so a typical MP4 shows a frozen player with
 * no sound. The proxy converts such media once to an MP4 the editor plays, H.264 with MP3, copying an
 * H.264 track as it is, and serves the copy with ranges so seeking works.
 */
const CONVERT = /^(video\/(mp4|quicktime|x-m4v|3gpp|x-matroska)|audio\/(mp4|aac|x-m4a|m4a))\b/i;
const DIR = join(tmpdir(), "threadside-media");
const KEEP_MS = 24 * 60 * 60 * 1000;
const FFMPEG = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"];

export function needsConversion(contentType: string): boolean {
  return CONVERT.test(contentType);
}

let ffmpegPath: string | null | undefined;
function ffmpeg(): string | undefined {
  if (ffmpegPath === undefined) {
    const fromPath = (process.env.PATH ?? "").split(":").map((dir) => join(dir, "ffmpeg"));
    ffmpegPath = [...fromPath, ...FFMPEG].find((candidate) => existsSync(candidate)) ?? null;
    if (!ffmpegPath) log().info("ffmpeg not found; AAC, HEVC and other media the editor cannot decode will not play in the chat. Install ffmpeg to convert it.");
  }
  return ffmpegPath ?? undefined;
}

export function canConvert(): boolean {
  return ffmpeg() !== undefined;
}

const jobs = new Map<string, Promise<string>>();

/** The playable copy of a media URL, made once per source version. `download` writes the original to a file. */
export function converted(key: string, audioOnly: boolean, download: (file: string) => Promise<void>): Promise<string> {
  const id = createHash("sha256").update(key).digest("hex").slice(0, 32);
  const out = join(DIR, `${id}.mp4`);
  if (existsSync(out)) return Promise.resolve(out);
  let job = jobs.get(id);
  if (!job) {
    job = convert(id, out, audioOnly, download).finally(() => jobs.delete(id));
    jobs.set(id, job);
  }
  return job;
}

function run(args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(ffmpeg()!, args, { timeout: 10 * 60_000 }, (error, _stdout, stderr) => (error ? reject(new Error(stderr.trim() || error.message)) : resolve(stderr))),
  );
}

async function convert(id: string, out: string, audioOnly: boolean, download: (file: string) => Promise<void>): Promise<string> {
  mkdirSync(DIR, { recursive: true });
  prune();
  const source = join(DIR, `${id}.source`);
  const partial = join(DIR, `${id}.part.mp4`);
  const started = Date.now();
  try {
    await download(source);
    // ffmpeg with no output lists the streams and exits with an error.
    const streams = await run(["-hide_banner", "-i", source]).catch((error: Error) => error.message);
    const h264 = /Stream #.*Video: h264\b/.test(streams);
    const video = audioOnly ? ["-vn"] : h264 ? ["-c:v", "copy"] : ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p"];
    await run(["-v", "error", "-y", "-i", source, ...video, "-c:a", "libmp3lame", "-b:a", "192k", "-f", "mp4", "-movflags", "+faststart", partial]);
    renameSync(partial, out);
    log().info(`Converted media for the editor (${h264 || audioOnly ? "audio only" : "video and audio"}) in ${Date.now() - started} ms.`);
    return out;
  } finally {
    rmSync(source, { force: true });
    rmSync(partial, { force: true });
  }
}

function prune(): void {
  const now = Date.now();
  for (const name of readdirSync(DIR)) {
    const file = join(DIR, name);
    try {
      if (now - statSync(file).mtimeMs > KEEP_MS) rmSync(file, { force: true });
    } catch {
      // Another window may have removed it first.
    }
  }
}

/** Serves a file with byte ranges, as media elements expect for seeking. */
export function serveFile(req: http.IncomingMessage, res: http.ServerResponse, file: string, contentType: string): void {
  const size = statSync(file).size;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ""));
  const headers = { "content-type": contentType, "accept-ranges": "bytes", "cache-control": "private, max-age=3600" };
  if (!match || (!match[1] && !match[2])) {
    res.writeHead(200, { ...headers, "content-length": size });
    if (req.method === "HEAD") return void res.end();
    createReadStream(file).pipe(res);
    return;
  }
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (start >= size || start > end) {
    res.writeHead(416, { "content-range": `bytes */${size}` });
    return void res.end();
  }
  res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": end - start + 1 });
  if (req.method === "HEAD") return void res.end();
  createReadStream(file, { start, end }).pipe(res);
}
