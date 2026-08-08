"use client";

import { useEffect, useState } from "react";
import { AGENT_OPTIONS, type AgentName } from "@/lib/agents";

const STORAGE_KEY = "spur:last-agent-model";

interface LastAgentSelection {
  lastAgent: AgentName | null;
  modelByAgent: Partial<Record<AgentName, string>>;
}

const EMPTY_SELECTION: LastAgentSelection = { lastAgent: null, modelByAgent: {} };

function isAgentName(value: unknown): value is AgentName {
  return typeof value === "string" && (AGENT_OPTIONS as readonly string[]).includes(value);
}

function readSelection(): LastAgentSelection {
  if (typeof window === "undefined") return EMPTY_SELECTION;
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return EMPTY_SELECTION;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return EMPTY_SELECTION;
    const record = parsed as Record<string, unknown>;
    const lastAgent = isAgentName(record["lastAgent"]) ? record["lastAgent"] : null;
    const rawModelByAgent = record["modelByAgent"];
    const modelByAgent: Partial<Record<AgentName, string>> = {};
    if (typeof rawModelByAgent === "object" && rawModelByAgent !== null) {
      for (const [agent, model] of Object.entries(rawModelByAgent as Record<string, unknown>)) {
        if (isAgentName(agent) && typeof model === "string") {
          modelByAgent[agent] = model;
        }
      }
    }
    return { lastAgent, modelByAgent };
  } catch {
    return EMPTY_SELECTION;
  }
}

function writeSelection(selection: LastAgentSelection) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(selection));
}

export interface UseLastAgentSelection {
  lastAgent: AgentName | null;
  modelByAgent: Partial<Record<AgentName, string>>;
  recordAgent: (agent: AgentName) => void;
  recordModel: (agent: AgentName, id: string) => void;
}

// Remembers the last-selected spawn agent and, per agent, the last-selected
// model, persisted in localStorage and kept in sync across tabs via the
// storage event (mirrors useFavorites.ts).
export function useLastAgentSelection(): UseLastAgentSelection {
  const [selection, setSelection] = useState<LastAgentSelection>(() => readSelection());

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY) setSelection(readSelection());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  return {
    lastAgent: selection.lastAgent,
    modelByAgent: selection.modelByAgent,
    recordAgent: (agent: AgentName) => {
      setSelection((current) => {
        const next = { ...current, lastAgent: agent };
        writeSelection(next);
        return next;
      });
    },
    recordModel: (agent: AgentName, id: string) => {
      setSelection((current) => {
        const next = { ...current, modelByAgent: { ...current.modelByAgent, [agent]: id } };
        writeSelection(next);
        return next;
      });
    },
  };
}
