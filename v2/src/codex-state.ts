const CODEX_HOOK_TRUST_MARKERS = ["Hooks need review", "Trust all and continue"] as const;
const CODEX_READY_MARKERS = ["OpenAI Codex", "›"] as const;

function lastMatchingMarker(
  pane: string,
  markers: readonly string[],
): { marker: string; index: number } | null {
  let best: { marker: string; index: number } | null = null;
  for (const marker of markers) {
    const index = pane.lastIndexOf(marker);
    if (index === -1) {
      continue;
    }
    if (!best || index > best.index) {
      best = { marker, index };
    }
  }
  return best;
}

export function codexShowsHookTrustPrompt(pane: string): boolean {
  const trustMarker = lastMatchingMarker(pane, CODEX_HOOK_TRUST_MARKERS);
  if (!trustMarker) {
    return false;
  }
  const readyMarker = lastMatchingMarker(pane, CODEX_READY_MARKERS);
  return !readyMarker || readyMarker.index < trustMarker.index;
}
