import { realpath, open, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, delimiter, isAbsolute, relative, sep } from "node:path";
import type { FileInput } from "./provider.js";

function mapFsError(error: unknown, path: string): Error {
  const name = basename(path) || "[path]";
  if (error instanceof Error && typeof (error as NodeJS.ErrnoException).code === "string") {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return new Error("File not found: " + name);
    if (code === "EACCES" || code === "EPERM") return new Error("Permission denied: " + name);
    if (code === "ELOOP") return new Error("Too many symbolic links: " + name);
    if (code === "ENOTDIR") return new Error("Path component is not a directory: " + name);
    if (code === "EISDIR") return new Error("Expected a regular file: " + name);
    return new Error("Unable to access file: " + name + " (" + code + ")");
  }
  return error instanceof Error ? error : new Error("Unable to access file: " + name);
}

async function realpathSafe(path: string): Promise<string> {
  try { return await realpath(path); } catch (error) { throw mapFsError(error, path); }
}

/** Read only explicitly allowed ordinary files, with bounded reads even if a file changes. */
export async function readAllowedFiles(paths: string[], signal: AbortSignal): Promise<FileInput[]> {
  const allowlist = (process.env.WEB_AI_ALLOWED_ROOTS || "").split(delimiter).map(path => path.trim()).filter(Boolean);
  if (!allowlist.length) throw new Error("Set WEB_AI_ALLOWED_ROOTS to enable local file analysis");
  if (allowlist.some(path => !isAbsolute(path))) throw new Error("WEB_AI_ALLOWED_ROOTS entries must be absolute paths");
  if (!paths.length || paths.length > 5) throw new Error("Select between one and five files");
  const roots = await Promise.all(allowlist.map(path => realpathSafe(path)));
  const files: FileInput[] = [];
  let total = 0;
  for (const path of paths) {
    try {
    signal.throwIfAborted();
    if (!isAbsolute(path)) throw new Error("Only absolute file paths are permitted");
    const actual = await realpathSafe(path);
    const permitted = roots.some(root => {
      const rel = relative(root, actual);
      return rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel);
    });
    if (!permitted) throw new Error("File outside allowed root: " + basename(actual));
    const expected = await stat(actual);
    const handle = await open(actual, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = await handle.stat();
      const current = await realpath(actual);
      const currentStat = await stat(current);
      if (current !== actual || opened.dev !== expected.dev || opened.ino !== expected.ino ||
          opened.dev !== currentStat.dev || opened.ino !== currentStat.ino) {
        throw new Error("File changed location while opening; select a stable file and retry");
      }
      if (!opened.isFile() || opened.size > 10 * 1024 * 1024) throw new Error("Only ordinary files up to 10 MiB are permitted");
      const buffer = Buffer.alloc(opened.size + 1);
      let length = 0;
      while (length < buffer.length) {
        signal.throwIfAborted();
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > opened.size) throw new Error("File grew during read; select a stable file and retry");
      total += length;
      if (total > 20 * 1024 * 1024) throw new Error("Total upload exceeds 20 MiB");
      files.push({ name: basename(actual), buffer: buffer.subarray(0, length) });
    } finally { await handle.close(); }
    } catch (error) { throw mapFsError(error, path); }
  }
  return files;
}
