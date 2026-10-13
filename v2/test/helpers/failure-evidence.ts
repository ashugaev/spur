import { cp, lstat, mkdir } from "node:fs/promises";
import { basename, join } from "node:path";

const CREDENTIAL_NAMES = new Set(["auth.json", ".credentials.json"]);
const CREDENTIAL_SUFFIXES = [".env", ".pem"];

export async function shouldCopyEvidence(sourcePath: string): Promise<boolean> {
  const name = basename(sourcePath);
  if (CREDENTIAL_NAMES.has(name)) return false;
  if (CREDENTIAL_SUFFIXES.some((suffix) => name.endsWith(suffix))) return false;
  return !(await lstat(sourcePath)).isSymbolicLink();
}

// Copies session state (data dir) and the smoke config out of a temp root so a
// failed run survives fixture teardown. Credentials and symlinks are skipped.
export async function copyFailureEvidence(rootDir: string, evidenceDir: string): Promise<void> {
  await mkdir(evidenceDir, { recursive: true });
  for (const name of ["data", "spur.yaml"]) {
    const source = join(rootDir, name);
    try {
      await cp(source, join(evidenceDir, name), {
        recursive: true,
        dereference: false,
        filter: shouldCopyEvidence,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
