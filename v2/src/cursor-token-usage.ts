import { readFile, readdir } from "node:fs/promises";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { shellEscape } from "./agents/shell-escape.js";
import type { TokenUsageTotals } from "./types.js";

const SCRIPT_NAME = "spur-cursor-token-usage.mjs";

// Cursor's interactive stop hook reports gross input (including both cache fields).
// Keep one snapshot per provider generation: repeated stop delivery must not add usage.
const SCRIPT = `import { mkdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
const configDir = process.env.CURSOR_CONFIG_DIR;
if (!process.env.SPUR_SESSION || !configDir) process.exit(0);
let input = '';
for await (const chunk of process.stdin) input += chunk;
try {
  const value = JSON.parse(input);
  if (typeof value.conversation_id !== 'string' || typeof value.generation_id !== 'string') process.exit(0);
  const usage = Object.fromEntries(['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens'].map(key => [key, value[key]]));
  if (!Object.values(usage).every(value => Number.isSafeInteger(value) && value >= 0)) process.exit(0);
  const dir = join(configDir, 'token-usage', Buffer.from(value.conversation_id).toString('hex'));
  await mkdir(dir, { recursive: true });
  const target = join(dir, Buffer.from(value.generation_id).toString('hex') + '.json');
  const temp = target + '.' + process.pid + '.tmp';
  await writeFile(temp, JSON.stringify(usage));
  await rename(temp, target);
} catch { /* Metering must never block the provider. */ }
`;

export function ensureCursorTokenUsageHook(home = homedir()): boolean {
  const dir = join(home, ".cursor");
  const lock = join(dir, ".spur-token-usage.lock");
  let locked = false;
  const temporary: string[] = [];
  try {
    mkdirSync(dir, { recursive: true });
    mkdirSync(lock);
    locked = true;
    const path = join(dir, "hooks.json");
    const readConfig = () => {
      try {
        return readFileSync(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    };
    const original = readConfig();
    const config: unknown =
      original === undefined ? { version: 1, hooks: {} } : JSON.parse(original);
    if (!config || typeof config !== "object" || Array.isArray(config)) return false;
    const record = config as Record<string, unknown>;
    if (record.version !== 1) return false;
    const hooks = record.hooks;
    if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return false;
    const entries = hooks as Record<string, unknown>;
    if (entries.stop !== undefined && !Array.isArray(entries.stop)) return false;
    const stop = (entries.stop ?? []) as unknown[];
    const scriptPath = join(dir, SCRIPT_NAME);
    const command = `node ${shellEscape(scriptPath)}`;
    const scriptTemp = `${scriptPath}.${randomUUID()}.tmp`;
    temporary.push(scriptTemp);
    writeFileSync(scriptTemp, SCRIPT, "utf8");
    renameSync(scriptTemp, scriptPath);
    const ownIndex = stop.findIndex(
      (entry) =>
        entry && typeof entry === "object" && "command" in entry && entry.command === command,
    );
    const own = ownIndex >= 0 ? (stop[ownIndex] as Record<string, unknown>) : undefined;
    if (own?.timeout === 30) return true;
    entries.stop = own
      ? stop.map((entry, index) => (index === ownIndex ? { ...own, timeout: 30 } : entry))
      : [...stop, { command, timeout: 30 }];
    const temp = `${path}.${randomUUID()}.tmp`;
    temporary.push(temp);
    writeFileSync(temp, JSON.stringify(config, null, 2) + "\n", "utf8");
    // Do not overwrite an editor's change made while preparing our additive update.
    if (readConfig() !== original) return false;
    renameSync(temp, path);
    return true;
  } catch {
    return false;
  } finally {
    for (const path of [...temporary, ...(locked ? [lock] : [])]) {
      try {
        rmSync(path, { recursive: true, force: true });
      } catch {
        /* Cleanup must not block launch. */
      }
    }
  }
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
