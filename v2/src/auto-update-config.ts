import {
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { isMap, parseDocument } from "yaml";
import { loadInstanceConfigReadOnly } from "./config.js";

// Single reader and single writer of the `autoUpdate` instance-config key.
// Disk is the source of truth: `readAutoUpdateFlag` re-parses the config
// file on every call (a full `parseConfigFile`, not a scalar read) so a hand
// edit, or a config that goes bad after boot, is always reflected — never a
// long-lived `service.config.autoUpdate` snapshot. `writeAutoUpdateFlag` is
// comment- and key-order-preserving (`parseDocument`, never `stringify`) and
// never throws: every failure mode, including a `yaml` `.set()` throw on a
// non-mapping document, comes back as a declared result reason.

export interface ReadAutoUpdateFlagResult {
  autoUpdate: boolean;
  error: string | null;
}

export function readAutoUpdateFlag(configPath: string): ReadAutoUpdateFlagResult {
  const result = loadInstanceConfigReadOnly(configPath);
  if (result.status === "ok") {
    return { autoUpdate: result.config.autoUpdate, error: null };
  }
  if (result.status === "invalid") {
    return { autoUpdate: false, error: result.error };
  }
  return { autoUpdate: false, error: `config not found at ${configPath}` };
}

export type WriteAutoUpdateResult =
  | { ok: true; autoUpdate: boolean }
  | {
      ok: false;
      reason: "conflict" | "config_invalid" | "not_mapping" | "missing" | "invalid_output" | "io";
      message: string;
    };

export function writeAutoUpdateFlag(configPath: string, enabled: boolean): WriteAutoUpdateResult {
  let tempPath: string | null = null;
  try {
    if (!existsSync(configPath)) {
      return { ok: false, reason: "missing", message: `config not found at ${configPath}` };
    }
    // Never write onto the unresolved path: replacing a symlinked config
    // with a regular file would silently detach it from wherever the
    // symlink pointed. The temp file lives beside the resolved target so
    // the rename is same-directory (atomic) and `parseConfigFile`'s
    // dataDir/worktreeDir resolution (relative to `dirname(configPath)`)
    // stays meaningful for the validation reads below.
    const resolved = realpathSync(configPath);

    const stampBefore = statSync(resolved);
    const text = readFileSync(resolved, "utf8");
    const doc = parseDocument(text);

    // A YAMLSeq or bare Scalar document (including a `---`-only document)
    // makes `.set()` throw. Check the structure directly rather than
    // relying on `loadInstanceConfigReadOnly` for this: that full parse
    // reports the SAME "config must be an object" error for a non-mapping
    // root as it does for an empty/comment-only file, which must succeed
    // (see below), so it cannot be the source of this classification.
    if (doc.contents !== null && !isMap(doc.contents)) {
      return { ok: false, reason: "not_mapping", message: `${resolved} is not a YAML mapping` };
    }

    // Empty and comment-only files parse to `contents === null`, which is
    // safe for `.set()`. They also fail full config validation ("config
    // must be an object"), but that failure describes the whole missing
    // root, not a broken `autoUpdate` field, so skip the validity/no-op
    // check below entirely when there is nothing yet to validate.
    if (doc.contents !== null) {
      // `absent` cannot happen here — `existsSync`/`realpathSync` above
      // already confirmed the file — so only `invalid` is mapped.
      const readResult = loadInstanceConfigReadOnly(resolved);
      if (readResult.status === "invalid") {
        return { ok: false, reason: "config_invalid", message: readResult.error };
      }
      if (readResult.status === "ok" && readResult.config.autoUpdate === enabled) {
        // No churn on the user's file: the effective value (default-applied)
        // already matches. Comparing the effective value rather than the
        // raw scalar means disarming an already-off host writes nothing.
        return { ok: true, autoUpdate: enabled };
      }
    }

    doc.set("autoUpdate", enabled);
    const next = doc.toString();

    tempPath = `${resolved}.tmp.${process.pid}.${Date.now()}`;
    // Enforced, not just implied by the template above: a temp file outside
    // `dirname(resolved)` makes the final `renameSync` cross a filesystem
    // boundary on a host where the config and the OS temp dir sit on
    // different devices, turning a routine disarm into an uncaught `EXDEV`
    // instead of the declared `io` result.
    if (dirname(tempPath) !== dirname(resolved)) {
      throw new Error("temp file must be created in the same directory as the resolved config");
    }
    writeFileSync(tempPath, next, "utf8");

    // Validate the produced text before it can ever land: a write that
    // silently corrupts the user's config must never reach the real path.
    const validated = loadInstanceConfigReadOnly(tempPath);
    if (validated.status !== "ok") {
      unlinkSync(tempPath);
      tempPath = null;
      return {
        ok: false,
        reason: "invalid_output",
        message: "produced config failed to parse back",
      };
    }

    const stampAfter = statSync(resolved);
    if (stampAfter.mtimeMs !== stampBefore.mtimeMs || stampAfter.size !== stampBefore.size) {
      // A concurrent hand edit landed between the two stats: never clobber it.
      unlinkSync(tempPath);
      tempPath = null;
      return { ok: false, reason: "conflict", message: `${resolved} changed on disk` };
    }

    renameSync(tempPath, resolved);
    tempPath = null;
    return { ok: true, autoUpdate: enabled };
  } catch (error) {
    if (tempPath) {
      try {
        unlinkSync(tempPath);
      } catch {
        // Best-effort cleanup only; the write already failed for another reason.
      }
    }
    return {
      ok: false,
      reason: "io",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
