"use client";

import { useEffect, useState } from "react";
import type { AgentName } from "@/lib/agents";
import type { AgentModel, SpawnDefaultsResponse } from "@/lib/types";

// The session's actual running model, carried across a respawn or handoff of
// the same agent. Mirrors resolveCarriedSpawnModel on the daemon
// (v2/src/session-service.ts): it only applies when the target agent matches
// the agent the session is currently running.
export interface CarrySpawnModel {
  agent: AgentName;
  model?: string;
}

// The single owner of the model preselection precedence chain: carried
// session model (same agent only) -> first favorite -> project-resolved
// default -> first list entry -> null only when the list is empty. Every
// rung is checked against the loaded model list, so a candidate the agent's
// catalog doesn't list falls through instead of preselecting a value the
// user could never have picked from the menu.
export function resolvePreselectedModelId(args: {
  agent: AgentName;
  models: AgentModel[];
  favoriteIds: ReadonlySet<string>;
  carry: CarrySpawnModel | null;
  projectDefaultModelId: string | null;
}): string | null {
  const { agent, models, favoriteIds, carry, projectDefaultModelId } = args;
  const isListed = (id: string | undefined | null): id is string =>
    id !== undefined && id !== null && models.some((model) => model.id === id);

  const carriedModel = carry !== null && carry.agent === agent ? carry.model : undefined;
  if (isListed(carriedModel)) return carriedModel;

  const favorite = models.find((model) => favoriteIds.has(model.id));
  if (favorite) return favorite.id;

  if (isListed(projectDefaultModelId)) return projectDefaultModelId;

  return models[0]?.id ?? null;
}

interface ResolvedSpawnDefaults {
  model: string | null;
  worktree: boolean | null;
  loading: boolean;
  error: string | null;
}

// Fetches the project+agent resolved spawn defaults. Returns worktree: null
// while unresolved (no project selected yet, or the request is in flight) so
// callers can tell "not yet known" apart from a real, resolved false.
export function useResolvedSpawnDefaults(
  projectId: string,
  agent: AgentName,
): ResolvedSpawnDefaults {
  // loading starts true whenever a projectId is already known at mount: the
  // effect below fetches unconditionally in that case, so the pre-effect
  // render must not read as settled.
  const [state, setState] = useState<ResolvedSpawnDefaults>({
    model: null,
    worktree: null,
    loading: Boolean(projectId),
    error: null,
  });

  useEffect(() => {
    if (!projectId) {
      setState({ model: null, worktree: null, loading: false, error: null });
      return;
    }
    let cancelled = false;
    setState({ model: null, worktree: null, loading: true, error: null });
    void fetch(
      `/api/projects/${encodeURIComponent(projectId)}/spawn-defaults?agent=${encodeURIComponent(agent)}`,
    )
      .then(async (response) => {
        const payload = (await response.json()) as SpawnDefaultsResponse | { error?: string };
        if (cancelled) return;
        if (!response.ok || !("worktree" in payload)) {
          const message =
            "error" in payload && payload.error ? payload.error : "Failed to load spawn defaults";
          setState({ model: null, worktree: null, loading: false, error: message });
          return;
        }
        setState({ model: payload.model, worktree: payload.worktree, loading: false, error: null });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          model: null,
          worktree: null,
          loading: false,
          error: err instanceof Error ? err.message : "Failed to load spawn defaults",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, agent]);

  return state;
}
