import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type SidecarSession = {
  id?: string;
  sidecars?: Array<{ name?: string; alive?: boolean }>;
  sidecarPorts?: Record<string, Record<string, number>>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseSidecarSessions(raw: string): SidecarSession[] | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;

    return parsed.filter((entry): entry is SidecarSession => isRecord(entry));
  } catch {
    return null;
  }
}

function parseSidecarSession(raw: string): SidecarSession | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseSessionIndex(raw: string): Record<string, string> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;

    const entries = Object.entries(parsed).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    );
    return Object.fromEntries(entries);
  } catch {
    return null;
  }
}

function readIsolatedUiPort(session: SidecarSession): number | null {
  if (!isRecord(session.sidecarPorts)) return null;
  const isolatedUiPorts = session.sidecarPorts["isolated-ui"];
  if (!isRecord(isolatedUiPorts)) return null;
  const port = isolatedUiPorts["SPUR_RESERVED_PORT_UI"];
  if (typeof port !== "number" || !Number.isInteger(port)) return null;
  return port;
}

function isolatedUiTmuxAlive(sessionId: string): boolean {
  try {
    execFileSync("tmux", ["has-session", "-t", `${sessionId}--isolated-ui`], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function readMetadataSidecarBaseUrl(env: NodeJS.ProcessEnv): string | null {
  const sessionId = env.SPUR_SESSION;
  if (!sessionId) return null;
  if (!isolatedUiTmuxAlive(sessionId)) return null;

  const dataDir = env.SPUR_DATA_DIR?.trim() || join(homedir(), ".spur");
  const index = parseSessionIndex(readFileSync(join(dataDir, "sessions", ".index.json"), "utf8"));
  const sessionRelativePath = index?.[sessionId];
  if (!sessionRelativePath) return null;

  const session = parseSidecarSession(readFileSync(join(dataDir, sessionRelativePath), "utf8"));
  if (!session) return null;

  const port = readIsolatedUiPort(session);
  return port ? `http://127.0.0.1:${port}` : null;
}

function readSidecarBaseUrl(env: NodeJS.ProcessEnv): string | null {
  const sessionId = env.SPUR_SESSION;
  const toolDir = env.SPUR_SESSION_TOOL_DIR;
  if (!sessionId || !toolDir) return null;

  const spurPath = join(toolDir, "spur");
  if (!existsSync(spurPath)) return null;

  try {
    const output = execFileSync(spurPath, ["list", "--json"], {
      encoding: "utf8",
      stdio: "pipe",
    });
    const sessions = parseSidecarSessions(output);
    if (!sessions) return readMetadataSidecarBaseUrl(env);
    const session = sessions.find((entry) => entry.id === sessionId);
    if (!session) return readMetadataSidecarBaseUrl(env);

    const uiSidecarAlive = session.sidecars?.some(
      (sidecar) => sidecar.name === "isolated-ui" && sidecar.alive,
    );
    const uiPort = session.sidecarPorts?.["isolated-ui"]?.SPUR_RESERVED_PORT_UI;
    if (!uiSidecarAlive || !uiPort) return readMetadataSidecarBaseUrl(env);

    return `http://127.0.0.1:${uiPort}`;
  } catch {
    try {
      return readMetadataSidecarBaseUrl(env);
    } catch {
      return null;
    }
  }
}

export function resolvePlaywrightBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PLAYWRIGHT_BASE_URL) return env.PLAYWRIGHT_BASE_URL;

  const sidecarBaseUrl = readSidecarBaseUrl(env);
  if (sidecarBaseUrl) return sidecarBaseUrl;

  if (env.SPUR_SESSION || env.SPUR_SESSION_TOOL_DIR) {
    throw new Error(
      'isolated-ui sidecar unavailable; start it with "$SPUR_SESSION_TOOL_DIR/spur-sidecar" --name isolated-ui or set PLAYWRIGHT_BASE_URL',
    );
  }

  return "http://localhost:5555";
}
