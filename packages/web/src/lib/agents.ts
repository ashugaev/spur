export const AGENT_OPTIONS = ["claude", "codex", "cursor", "opencode"] as const;

export type AgentName = (typeof AGENT_OPTIONS)[number];

const AGENT_LABELS: Record<AgentName, string> = {
  claude: "claude",
  codex: "codex",
  cursor: "cursor",
  opencode: "opencode",
};

export function getAgentDisplayName(agent: AgentName): string {
  return AGENT_LABELS[agent];
}
