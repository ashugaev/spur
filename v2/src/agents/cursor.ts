import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { shellEscape } from "./shell-escape.js";
import { resolveWorktreePathCandidates } from "./worktree-path.js";
import type { AgentLaunchPlan, AgentResumePlan } from "./types.js";

const CURSOR_TRUST_FILENAME = ".workspace-trusted";

interface CursorSessionFile {
  chatId: string;
  mtimeMs: number;
}

export function cursorCommand(): string {
  return process.env["SPUR_CURSOR_BIN"] || "agent";
}

export function cursorConfigDir(): string {
  return process.env["CURSOR_CONFIG_DIR"] || join(homedir(), ".cursor");
}

export function cursorConfigDirForSession(dataDir: string, sessionId: string): string {
  return join(dataDir, "cursor", sessionId);
}

async function findLatestCursorSessionFile(projectDir: string): Promise<CursorSessionFile | null> {
  let entries: string[];
  try {
    entries = await readdir(projectDir);
  } catch {
    return null;
  }

  const files = await Promise.all(
    entries.map(async (entry) => {
      const storePath = join(projectDir, entry, "store.db");
      try {
        const fileStat = await stat(storePath);
        return { chatId: entry, mtimeMs: fileStat.mtimeMs } satisfies CursorSessionFile;
      } catch {
        return null;
      }
    }),
  );
  const existing = files.filter((file): file is CursorSessionFile => Boolean(file));
  existing.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return existing[0] ?? null;
}

export async function findCursorSessionId(
  worktreePath: string,
  options?: { configDir?: string },
): Promise<string | null> {
  let best: CursorSessionFile | null = null;
  const configDir = options?.configDir ?? cursorConfigDir();
  for (const candidate of await resolveWorktreePathCandidates(worktreePath)) {
    const pathHash = createHash("md5").update(resolve(candidate)).digest("hex");
    const match = await findLatestCursorSessionFile(join(configDir, "chats", pathHash));
    if (match && (!best || match.mtimeMs > best.mtimeMs)) {
      best = match;
    }
  }
  return best?.chatId ?? null;
}

export function buildCursorPlan(prompt: string, options?: { planMode?: boolean }): AgentLaunchPlan {
  const planArg = options?.planMode ? " --plan" : "";
  return {
    launchCommand: `${cursorCommand()} --force --sandbox disabled${planArg}`,
    initialMessage: prompt,
    readyMarkers: ["Cursor Agent"],
  };
}

export function buildCursorResumePlan(
  chatId: string,
  binary = cursorCommand(),
  options?: { planMode?: boolean },
): AgentResumePlan {
  const planArg = options?.planMode ? " --plan" : "";
  return {
    launchCommand: `${shellEscape(binary)} --resume ${shellEscape(chatId)} --force --sandbox disabled${planArg}`,
    readyMarkers: ["Cursor Agent"],
  };
}

export async function buildCursorRestorePlan(
  worktreePath: string,
  prompt: string,
  options?: { planMode?: boolean; cursorConfigDir?: string },
): Promise<AgentLaunchPlan | null> {
  const chatId = await findCursorSessionId(
    worktreePath,
    options?.cursorConfigDir ? { configDir: options.cursorConfigDir } : undefined,
  );
  if (!chatId) {
    return null;
  }

  return {
    ...buildCursorResumePlan(chatId, cursorCommand(), options),
    initialMessage: prompt,
  };
}

export async function ensureCursorWorkspaceTrust(worktreePath: string): Promise<void> {
  const cursorDir = join(worktreePath, ".cursor");
  const trustPath = join(cursorDir, CURSOR_TRUST_FILENAME);
  if (existsSync(trustPath)) {
    return;
  }

  await mkdir(cursorDir, { recursive: true });
  await writeFile(
    trustPath,
    JSON.stringify(
      {
        trustedAt: new Date().toISOString(),
        workspacePath: resolve(worktreePath),
        trustMethod: "spur",
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
}
