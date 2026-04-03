import type { AttentionLevel } from "@/lib/types";

/** Border + background class pair per attention level, shared by cards and lanes. */
export const toneClasses: Record<AttentionLevel, string> = {
  respond: "border-red-500/25 bg-red-500/[0.06]",
  review: "border-orange-400/25 bg-orange-400/[0.06]",
  pending: "border-amber-400/25 bg-amber-400/[0.06]",
  working: "border-sky-400/25 bg-sky-400/[0.06]",
  done: "border-white/10 bg-white/[0.03]",
};
