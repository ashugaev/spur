import type { ProjectConfig, SessionRecord, SidecarConfig, SidecarMcpBinding } from "../types.js";

// Fully config-driven: a project's `sidecars` map already carries every
// built-in's command/ports/mcp/agents (merged in at config load, see
// config.ts:parseSidecars). Resolution here only applies the per-session
// agent filter — no per-session override state exists.
export function resolveSessionSidecars(
  session: Pick<SessionRecord, "agent">,
  project?: Pick<ProjectConfig, "sidecars">,
): Record<string, SidecarConfig> {
  const sidecars = project?.sidecars ?? {};
  const resolved: Record<string, SidecarConfig> = {};
  for (const [name, sidecar] of Object.entries(sidecars)) {
    if (sidecar.agents && !sidecar.agents.includes(session.agent)) continue;
    resolved[name] = sidecar;
  }
  return resolved;
}

// Sidecar names an agent could sensibly be told to start manually (the
// initial-message "Available: ..." hint, see buildInitialMessage in
// session-service.ts). MCP-bound sidecars are excluded: those are started
// automatically pre-launch by startMcpSidecars, so listing them there would
// invite either a no-op (already running) or, once a session's agent doesn't
// carry it, a rejected manual start.
export function manualSidecarNames(sidecars: Record<string, SidecarConfig>): string[] {
  return Object.entries(sidecars)
    .filter(([, sidecar]) => !sidecar.mcp)
    .map(([name]) => name);
}

// Build the SidecarMcpBinding[] to hand to an agent's launch plan: one entry
// per resolved sidecar that carries `mcp` and has a reserved port for it.
export function collectMcpBindings(
  sidecars: Record<string, SidecarConfig>,
  sidecarPorts: Record<string, Record<string, number>> | undefined,
): SidecarMcpBinding[] {
  const bindings: SidecarMcpBinding[] = [];
  for (const [name, sidecar] of Object.entries(sidecars)) {
    if (!sidecar.mcp) continue;
    const portConfig = sidecar.ports?.[sidecar.mcp.portId];
    if (!portConfig) continue;
    const port = sidecarPorts?.[name]?.[portConfig.env];
    if (typeof port !== "number") continue;
    const host = sidecar.mcp.clientHost ?? "localhost";
    bindings.push({ server: sidecar.mcp.server, url: `http://${host}:${port}${sidecar.mcp.path}` });
  }
  return bindings;
}
