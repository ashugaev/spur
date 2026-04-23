import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { AgentName, AgentSuggestionEntry, AgentSuggestionsResponse } from "./types.js";

const CACHE_TTL_MS = 5_000;
const MAX_SCAN_DEPTH = 6;

const CLAUDE_BUILTIN_COMMANDS = [
  command("agents", "Manage agent configurations"),
  command("add-dir", "Add a working directory for file access"),
  command("clear", "Start a new conversation with empty context"),
  command("compact", "Summarize the current conversation"),
  command("config", "Open Claude settings"),
  command("cost", "Show usage and token cost"),
  command("doctor", "Run environment diagnostics"),
  command("help", "Show available commands"),
  command("init", "Initialize repository instructions"),
  command("memory", "Inspect saved memory"),
  command("model", "Switch the active model"),
  command("permissions", "Adjust Claude permissions"),
  command("resume", "Resume an earlier conversation"),
  command("review", "Run code review flow"),
  command("status", "Show current session status"),
] satisfies AgentSuggestionEntry[];

const CODEX_BUILTIN_COMMANDS = [
  command("agent", "Inspect or switch active agent threads"),
  command("apps", "Browse configured apps"),
  command("clear", "Clear the chat and terminal view"),
  command("compact", "Summarize the visible conversation"),
  command("copy", "Copy the latest completed output"),
  command("diff", "Show the current git diff"),
  command("exit", "Exit the Codex CLI"),
  command("experimental", "Toggle experimental features"),
  command("feedback", "Send feedback and diagnostics"),
  command("init", "Generate an AGENTS.md scaffold"),
  command("logout", "Clear local credentials"),
  command("mcp", "List configured MCP tools"),
  command("mention", "Attach a file or folder"),
  command("model", "Switch the current model"),
  command("permissions", "Adjust approvals in-session"),
  command("plan", "Switch plan mode"),
  command("plugins", "Inspect installed plugins"),
  command("review", "Start review mode"),
  command("status", "Show session details and IDs"),
] satisfies AgentSuggestionEntry[];

interface CacheEntry {
  expiresAt: number;
  value: AgentSuggestionsResponse;
}

interface SuggestionContext {
  agent: AgentName;
  projectPath: string;
  codexHomePath?: string;
}

const cache = new Map<string, CacheEntry>();

export async function loadProjectSuggestions(
  agent: AgentName,
  projectPath: string,
): Promise<AgentSuggestionsResponse> {
  return loadSuggestions({
    agent,
    projectPath,
  });
}

export async function loadSessionSuggestions(input: {
  agent: AgentName;
  worktreePath: string;
  codexHomePath?: string;
}): Promise<AgentSuggestionsResponse> {
  return loadSuggestions({
    agent: input.agent,
    projectPath: input.worktreePath,
    ...(input.codexHomePath ? { codexHomePath: input.codexHomePath } : {}),
  });
}

function command(name: string, detail: string): AgentSuggestionEntry {
  return {
    id: `builtin:${name}`,
    label: `/${name}`,
    insertText: `/${name}`,
    detail,
    source: "built-in",
    kind: "command",
  };
}

function skillInsertText(agent: AgentName, name: string): string {
  return agent === "codex" ? `$${name}` : `/${name}`;
}

function agentInsertText(name: string): string {
  return `Use the ${name} agent to `;
}

function cacheKey(context: SuggestionContext): string {
  return `${context.agent}:${context.projectPath}:${context.codexHomePath ?? ""}`;
}

function isPresent<T>(value: T | null): value is T {
  return value !== null;
}

async function loadSuggestions(context: SuggestionContext): Promise<AgentSuggestionsResponse> {
  const key = cacheKey(context);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const value =
    context.agent === "claude"
      ? await loadClaudeSuggestions(context.projectPath)
      : await loadCodexSuggestions(context.projectPath, context.codexHomePath);
  cache.set(key, {
    expiresAt: Date.now() + CACHE_TTL_MS,
    value,
  });
  return value;
}

async function loadClaudeSuggestions(projectPath: string): Promise<AgentSuggestionsResponse> {
  const commands = dedupeSuggestions([
    ...CLAUDE_BUILTIN_COMMANDS,
    ...(await readClaudeCommandFiles(projectPath)),
    ...(await readClaudePluginCommands()),
  ]);
  const skills = dedupeSuggestions([
    ...(await readSkillDirs("claude", join(projectPath, ".claude", "skills"), "project")),
    ...(await readSkillDirs("claude", join(homedir(), ".claude", "skills"), "user")),
  ]);
  const agents = dedupeSuggestions([
    ...(await readMarkdownAgents("claude", join(projectPath, ".claude", "agents"), "project")),
    ...(await readMarkdownAgents("claude", join(homedir(), ".claude", "agents"), "user")),
  ]);
  return {
    agent: "claude",
    commands,
    skills,
    agents,
  };
}

async function loadCodexSuggestions(
  projectPath: string,
  codexHomePath?: string,
): Promise<AgentSuggestionsResponse> {
  const commands = dedupeSuggestions([
    ...CODEX_BUILTIN_COMMANDS,
    ...(await readCodexPrompts(codexHomePath ?? join(homedir(), ".codex"), Boolean(codexHomePath))),
  ]);
  const skills = dedupeSuggestions([
    ...(await readSkillDirs("codex", join(projectPath, ".agents", "skills"), "project")),
    ...(await readSkillDirs("codex", join(homedir(), ".codex", "skills"), "user")),
  ]);
  const agents = dedupeSuggestions([
    ...(await readMarkdownAgents("codex", join(projectPath, ".agents", "agents"), "project")),
    ...(await readCodexTomlAgents(
      join(codexHomePath ?? join(homedir(), ".codex"), "agents"),
      codexHomePath ? "session" : "user",
    )),
  ]);
  return {
    agent: "codex",
    commands,
    skills,
    agents,
  };
}

function dedupeSuggestions(items: AgentSuggestionEntry[]): AgentSuggestionEntry[] {
  const seen = new Set<string>();
  const deduped: AgentSuggestionEntry[] = [];
  for (const item of items) {
    const key = `${item.kind}:${item.label}:${item.source}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(item);
  }
  return deduped.sort((left, right) => left.label.localeCompare(right.label));
}

async function readSkillDirs(
  agent: AgentName,
  rootDir: string,
  source: AgentSuggestionEntry["source"],
): Promise<AgentSuggestionEntry[]> {
  const dirNames = await listDirectoryNames(rootDir);
  const items = await Promise.all(
    dirNames
      .filter((name) => !name.startsWith("."))
      .map(async (name) => {
        const filePath = join(rootDir, name, "SKILL.md");
        if (!existsSync(filePath)) {
          return null;
        }
        const content = await readTextFile(filePath);
        if (content === null) {
          return null;
        }
        const meta = parseFrontmatter(content);
        const skillName = meta["name"]?.trim() || name;
        return {
          id: `skill:${source}:${skillName}`,
          label: skillName,
          insertText: skillInsertText(agent, skillName),
          detail: meta["description"]?.trim() || `Use the ${skillName} skill`,
          source,
          kind: "skill",
        } satisfies AgentSuggestionEntry;
      }),
  );
  return items.filter(isPresent);
}

async function readMarkdownAgents(
  agent: AgentName,
  rootDir: string,
  source: AgentSuggestionEntry["source"],
): Promise<AgentSuggestionEntry[]> {
  const fileNames = await listFileNames(rootDir, (name) => name.endsWith(".md"));
  const items = await Promise.all(
    fileNames.map(async (name) => {
      const filePath = join(rootDir, name);
      const content = await readTextFile(filePath);
      if (content === null) {
        return null;
      }
      const meta = parseFrontmatter(content);
      const agentName = meta["name"]?.trim() || basename(name, ".md");
      return {
        id: `agent:${source}:${agentName}`,
        label: agentName,
        insertText: agentInsertText(agentName),
        detail: meta["description"]?.trim() || `Use the ${agentName} agent`,
        source,
        kind: "agent",
      } satisfies AgentSuggestionEntry;
    }),
  );
  return items.filter(isPresent);
}

async function readCodexTomlAgents(
  rootDir: string,
  source: AgentSuggestionEntry["source"],
): Promise<AgentSuggestionEntry[]> {
  const fileNames = await listFileNames(rootDir, (name) => name.endsWith(".toml"));
  const items = await Promise.all(
    fileNames.map(async (name) => {
      const content = await readTextFile(join(rootDir, name));
      if (content === null) {
        return null;
      }
      const agentName = readTomlString(content, "name") || basename(name, ".toml");
      return {
        id: `agent:${source}:${agentName}`,
        label: agentName,
        insertText: agentInsertText(agentName),
        detail: readTomlString(content, "description") || `Use the ${agentName} agent`,
        source,
        kind: "agent",
      } satisfies AgentSuggestionEntry;
    }),
  );
  return items.filter(isPresent);
}

async function readClaudeCommandFiles(projectPath: string): Promise<AgentSuggestionEntry[]> {
  const custom = await readMarkdownCommands(join(projectPath, ".claude", "commands"), "project");
  const user = await readMarkdownCommands(join(homedir(), ".claude", "commands"), "user");
  return [...custom, ...user];
}

async function readClaudePluginCommands(): Promise<AgentSuggestionEntry[]> {
  const rootDir = join(homedir(), ".claude", "plugins");
  const filePaths = await collectMatchingFiles(rootDir, (path) => path.includes("/commands/"));
  const items = await Promise.all(
    filePaths
      .filter((filePath) => filePath.endsWith(".md"))
      .map(async (filePath) => {
        const content = await readTextFile(filePath);
        if (content === null) {
          return null;
        }
        const commandName = basename(filePath, ".md");
        const pluginName = filePath.split("/plugins/")[1]?.split("/")[0]?.trim();
        const label = pluginName ? `${pluginName}:${commandName}` : commandName;
        const meta = parseFrontmatter(content);
        return {
          id: `command:plugin:${label}`,
          label: `/${label}`,
          insertText: `/${label}`,
          detail: meta["description"]?.trim() || `Run the ${label} command`,
          source: "plugin",
          kind: "command",
        } satisfies AgentSuggestionEntry;
      }),
  );
  return items.filter(isPresent);
}

async function readMarkdownCommands(
  rootDir: string,
  source: AgentSuggestionEntry["source"],
): Promise<AgentSuggestionEntry[]> {
  const fileNames = await listFileNames(rootDir, (name) => name.endsWith(".md"));
  const items = await Promise.all(
    fileNames.map(async (name) => {
      const content = await readTextFile(join(rootDir, name));
      if (content === null) {
        return null;
      }
      const meta = parseFrontmatter(content);
      const commandName = basename(name, ".md");
      return {
        id: `command:${source}:${commandName}`,
        label: `/${commandName}`,
        insertText: `/${commandName}`,
        detail: meta["description"]?.trim() || `Run the ${commandName} command`,
        source,
        kind: "command",
      } satisfies AgentSuggestionEntry;
    }),
  );
  return items.filter(isPresent);
}

async function readCodexPrompts(
  codexRoot: string,
  sessionScoped: boolean,
): Promise<AgentSuggestionEntry[]> {
  const rootDir = join(codexRoot, "prompts");
  const fileNames = await listFileNames(rootDir, (name) => name.endsWith(".md"));
  const items = await Promise.all(
    fileNames.map(async (name) => {
      const content = await readTextFile(join(rootDir, name));
      if (content === null) {
        return null;
      }
      const meta = parseFrontmatter(content);
      const promptName = basename(name, ".md");
      const argumentHint = meta["argument-hint"]?.trim();
      return {
        id: `command:${sessionScoped ? "session" : "user"}:prompts:${promptName}`,
        label: `/prompts:${promptName}`,
        insertText: `/prompts:${promptName}${argumentHint ? " " : ""}`,
        detail: meta["description"]?.trim() || "Run a reusable prompt",
        source: sessionScoped ? "session" : "user",
        kind: "command",
      } satisfies AgentSuggestionEntry;
    }),
  );
  return items.filter(isPresent);
}

function parseFrontmatter(content: string): Record<string, string> {
  if (!content.startsWith("---\n")) {
    return {};
  }
  const end = content.indexOf("\n---\n", 4);
  if (end === -1) {
    return {};
  }
  const block = content.slice(4, end).split("\n");
  const result: Record<string, string> = {};
  for (const line of block) {
    const separator = line.indexOf(":");
    if (separator <= 0) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^"(.*)"$/, "$1");
    if (key) {
      result[key] = value;
    }
  }
  return result;
}

function readTomlString(content: string, key: string): string | null {
  const match = content.match(new RegExp(`^${escapeRegExp(key)}\\s*=\\s*"(.*)"\\s*$`, "m"));
  return match?.[1]?.trim() || null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function readTextFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function listDirectoryNames(rootDir: string): Promise<string[]> {
  try {
    const entries = await readdir(rootDir, { encoding: "utf8", withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function listFileNames(rootDir: string, match: (name: string) => boolean): Promise<string[]> {
  try {
    const entries = await readdir(rootDir, { encoding: "utf8", withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && match(entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function collectMatchingFiles(
  rootDir: string,
  matchPath: (path: string) => boolean,
  depth = 0,
): Promise<string[]> {
  if (depth > MAX_SCAN_DEPTH) {
    return [];
  }
  const files: string[] = [];
  try {
    const entries = await readdir(rootDir, { encoding: "utf8", withFileTypes: true });
    for (const entry of entries) {
      const filePath = join(rootDir, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await collectMatchingFiles(filePath, matchPath, depth + 1)));
        continue;
      }
      if (entry.isFile() && matchPath(filePath)) {
        files.push(filePath);
      }
    }
  } catch {
    return [];
  }
  return files;
}
