import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { shellEscape } from "./agents/shell-escape.js";
import type { TokenUsageTotals } from "./types.js";

const SCRIPT_NAME = "spur-cursor-token-usage.mjs";

// Cursor's interactive stop hook reports gross input (including both cache fields).
// Keep one snapshot per provider generation: repeated stop delivery must not add usage.
const SCRIPT = `import { mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
let input = '';
for await (const chunk of process.stdin) input += chunk;
try {
  const value = JSON.parse(input);
  if (typeof value.conversation_id !== 'string' || typeof value.generation_id !== 'string') process.exit(0);
  const usage = Object.fromEntries(['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens'].map(key => [key, value[key]]));
  if (!Object.values(usage).every(value => Number.isSafeInteger(value) && value >= 0)) process.exit(0);
  const dir = join(dirname(fileURLToPath(import.meta.url)), 'token-usage', Buffer.from(value.conversation_id).toString('hex'));
  await mkdir(dir, { recursive: true });
  const target = join(dir, Buffer.from(value.generation_id).toString('hex') + '.json');
  const temp = target + '.' + process.pid + '.tmp';
  await writeFile(temp, JSON.stringify(usage));
  await rename(temp, target);
} catch { /* Metering must never block the provider. */ }
`;

export async function ensureCursorTokenUsageHook(
  worktreePath: string,
  configDir: string,
): Promise<void> {
  await mkdir(configDir, { recursive: true });
  const scriptPath = join(configDir, SCRIPT_NAME);
  await writeFile(scriptPath, SCRIPT, "utf8");
  const hooksDir = join(worktreePath, ".cursor");
  await mkdir(hooksDir, { recursive: true });
  const hooksPath = join(hooksDir, "hooks.json");
  let config: Record<string, unknown> = { version: 1 };
  try {
    const parsed: unknown = JSON.parse(await readFile(hooksPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Invalid Cursor hooks configuration");
    }
    config = parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const hooks = config["hooks"];
  if (hooks !== undefined && (!hooks || typeof hooks !== "object" || Array.isArray(hooks))) {
    throw new Error("Invalid Cursor hooks configuration");
  }
  const entries = { ...(hooks as Record<string, unknown> | undefined) };
  const stop = entries["stop"];
  if (stop !== undefined && !Array.isArray(stop)) throw new Error("Invalid Cursor stop hooks");
  entries["stop"] = [
    ...(Array.isArray(stop) ? stop : []).filter((entry: unknown) => {
      if (!entry || typeof entry !== "object") return true;
      const command = (entry as Record<string, unknown>)["command"];
      return typeof command !== "string" || !command.includes(SCRIPT_NAME);
    }),
    { command: `node ${shellEscape(scriptPath)}`, timeout: 5 },
  ];
  const temp = `${hooksPath}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify({ ...config, hooks: entries }, null, 2) + "\n");
  await rename(temp, hooksPath);
}

export async function readCursorTokenUsage(
  configDir: string,
  conversationId: string | undefined,
): Promise<TokenUsageTotals | undefined> {
  if (!conversationId) return undefined;
  const dir = join(configDir, "token-usage", Buffer.from(conversationId).toString("hex"));
  try {
    const files = (await readdir(dir)).filter((file) => file.endsWith(".json"));
    if (files.length === 0) return undefined;
    const totals = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
    };
    for (const file of files) {
      const value: unknown = JSON.parse(await readFile(join(dir, file), "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
      const record = value as Record<string, unknown>;
      const input = record["input_tokens"];
      const output = record["output_tokens"];
      const read = record["cache_read_tokens"];
      const write = record["cache_write_tokens"];
      if (
        typeof input !== "number" ||
        typeof output !== "number" ||
        typeof read !== "number" ||
        typeof write !== "number" ||
        ![input, output, read, write].every((value) => Number.isSafeInteger(value) && value >= 0) ||
        read + write > input
      )
        return undefined;
      totals.inputTokens += input;
      totals.outputTokens += output;
      totals.totalTokens += input + output;
      totals.cacheReadInputTokens += read;
      totals.cacheWriteInputTokens += write;
    }
    return Object.values(totals).every(Number.isSafeInteger) ? totals : undefined;
  } catch {
    return undefined;
  }
}
