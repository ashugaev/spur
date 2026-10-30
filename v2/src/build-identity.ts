import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const runtimeDirectory = dirname(fileURLToPath(import.meta.url));

/** Hash installed executable files; paths delimit identical concatenated bytes. */
export function computeBuildId(directory: string = runtimeDirectory): string {
  const files: string[] = [];
  function collect(current: string): void {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) collect(path);
      else if (entry.isFile() && entry.name.endsWith(".js")) files.push(path);
    }
  }
  collect(directory);
  const digest = createHash("sha256");
  for (const path of files.sort()) {
    digest.update(relative(directory, path));
    digest.update("\0");
    digest.update(readFileSync(path));
    digest.update("\0");
  }
  return digest.digest("hex");
}

// Capture before runtime requests: replacing installed files cannot rewrite
// the identity of a process that still executes the previous generation.
const startupBuildId = computeBuildId();

export function getBuildId(): string {
  return startupBuildId;
}
