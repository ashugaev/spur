export function telegramStatusEmoji(state: string): string {
  if (state === "working") return "🟢";
  if (state === "waiting") return "🟡";
  if (state === "needs_input") return "🔴";
  if (state === "error") return "🔴";
  if (state === "rate_limited") return "⏳";
  if (state === "killed" || state === "stopped") return "⚫";
  return "⚪";
}
