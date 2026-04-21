export const AGENT_OPTIONS = ["claude", "codex", "cursor"] as const;

export type AgentName = (typeof AGENT_OPTIONS)[number];

const AGENT_LABELS: Record<AgentName, string> = {
  claude: "Claude Code",
  codex: "Codex CLI",
  cursor: "Cursor Agent",
};

export function getAgentDisplayName(agent: AgentName): string {
  return AGENT_LABELS[agent];
}

export function agentUsesBracketedPaste(agent: AgentName): boolean {
  return agent !== "cursor";
}
