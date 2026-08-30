import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";

// TMPDIR can outlive the per-session temp dir it points at (the session that
// set it may have been torn down). A write that silently fails there drops
// the message it was carrying, so ensure the preferred dir exists and fall
// back to the always-present "/tmp" rather than let the caller ENOENT.
export function resolveTempDir(): string {
  const preferred = tmpdir();
  try {
    mkdirSync(preferred, { recursive: true });
    return preferred;
  } catch {
    mkdirSync("/tmp", { recursive: true });
    return "/tmp";
  }
}
