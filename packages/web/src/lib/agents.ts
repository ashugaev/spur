export const AGENT_OPTIONS = ["claude", "codex", "cursor"] as const;

export type AgentName = (typeof AGENT_OPTIONS)[number];

const AGENT_LABELS: Record<AgentName, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
};

export function getAgentDisplayName(agent: AgentName): string {
  return AGENT_LABELS[agent];
}

export function agentUsesBracketedPaste(agent: AgentName): boolean {
  return agent !== "cursor";
}
