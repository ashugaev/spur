import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

type SidecarSession = {
  id?: string;
  sidecars?: Array<{ name?: string; alive?: boolean }>;
  sidecarPorts?: Record<string, Record<string, number>>;
};

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
    const sessions = JSON.parse(output) as SidecarSession[];
    const session = sessions.find((entry) => entry.id === sessionId);
    if (!session) return null;

    const uiSidecarAlive = session.sidecars?.some(
      (sidecar) => sidecar.name === "isolated-ui" && sidecar.alive,
    );
    const uiPort = session.sidecarPorts?.["isolated-ui"]?.SPUR_RESERVED_PORT_UI;
    if (!uiSidecarAlive || !uiPort) return null;

    return `http://127.0.0.1:${uiPort}`;
  } catch {
    return null;
  }
}

export function resolvePlaywrightBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.PLAYWRIGHT_BASE_URL ?? readSidecarBaseUrl(env) ?? "http://localhost:5555";
}
