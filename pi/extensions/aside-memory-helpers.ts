import { lstatSync, readdirSync, realpathSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

export const MAX_OUTPUT_BYTES = 50 * 1024;
export const MAX_OUTPUT_LINES = 2000;
const IGNORED_DIRECTORIES = new Set([".moss-cache"]);

function isWithin(root: string, target: string): boolean {
  const pathFromRoot = relative(root, target);
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
}

export function truncateMemoryOutput(output: string): string {
  const lines = output.split("\n");
  const originalBytes = Buffer.byteLength(output);
  if (lines.length <= MAX_OUTPUT_LINES && originalBytes <= MAX_OUTPUT_BYTES) return output;

  const notice = `[Output truncated to ${MAX_OUTPUT_LINES.toLocaleString()} lines or 50 KB.]`;
  const kept: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    if (kept.length >= MAX_OUTPUT_LINES - 1) break;
    const separatorBytes = kept.length === 0 ? 0 : 1;
    const lineBytes = Buffer.byteLength(line);
    if (bytes + separatorBytes + lineBytes + 1 + Buffer.byteLength(notice) > MAX_OUTPUT_BYTES) break;
    kept.push(line);
    bytes += separatorBytes + lineBytes;
  }
  return [...kept, notice].join("\n");
}

export function listMemoryFiles(memoryRoot: string): string[] {
  const root = realpathSync(memoryRoot);
  const results: string[] = [];

  function visit(directory: string, prefix: string): void {
    for (const entry of readdirSync(directory)) {
      if (entry.startsWith(".") || IGNORED_DIRECTORIES.has(entry)) continue;
      const fullPath = join(directory, entry);
      const stats = lstatSync(fullPath);
      if (stats.isSymbolicLink()) continue;
      const relativePath = prefix ? `${prefix}/${entry}` : entry;
      if (stats.isDirectory()) {
        visit(fullPath, relativePath);
      } else if (stats.isFile() && entry.endsWith(".md")) {
        results.push(relativePath);
      }
    }
  }

  visit(root, "");
  return results;
}

export function readMemoryFile(memoryRoot: string, requestedPath: string): string {
  if (isAbsolute(requestedPath)) throw new Error("path must be relative to memory root.");
  const root = realpathSync(memoryRoot);
  const unresolvedPath = resolve(root, requestedPath);
  if (!isWithin(root, unresolvedPath)) throw new Error("path escapes memory root.");

  const unresolvedStats = lstatSync(unresolvedPath);
  if (unresolvedStats.isSymbolicLink()) throw new Error("symlinked paths are not allowed.");
  const resolvedPath = realpathSync(unresolvedPath);
  if (!isWithin(root, resolvedPath)) throw new Error("path escapes memory root through a symlink.");
  if (!lstatSync(resolvedPath).isFile()) throw new Error("path is not a regular file.");
  return readFileSync(resolvedPath, "utf8");
}
