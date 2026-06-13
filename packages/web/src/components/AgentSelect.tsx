"use client";

import { INPUT_CLASS } from "@/design/classes";
import { AGENT_OPTIONS, getAgentDisplayName, type AgentName } from "@/lib/agents";

export function AgentSelect({
  value,
  onChange,
  ariaLabel = "Agent",
}: {
  value: AgentName;
  onChange: (next: AgentName) => void;
  ariaLabel?: string;
}) {
  return (
    <select
      aria-label={ariaLabel}
      className={INPUT_CLASS}
      onChange={(event) => onChange(event.target.value as AgentName)}
      value={value}
    >
      {AGENT_OPTIONS.map((agent) => (
        <option key={agent} value={agent}>
          {getAgentDisplayName(agent)}
        </option>
      ))}
    </select>
  );
}
