import { extractLinkId } from "@/lib/link-icons";
import { isGeneratedBootstrapPrompt, parseSessionPromptView } from "@/lib/session-prompt";
import type { DashboardSession } from "@/lib/types";

const VISIBLE_WORK_ITEM_ID_RE = /^(?:#\d+|!\d+|[A-Z]+-\d+)$/;

export function matchesSessionSearch(session: DashboardSession, query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return true;
  }

  const workItemIds = session.links
    .map(extractLinkId)
    .filter((identifier) => VISIBLE_WORK_ITEM_ID_RE.test(identifier));
  const task = parseSessionPromptView(session).task;
  const corpus = [
    session.id,
    session.title ?? "",
    session.projectName,
    session.branch ?? "",
    isGeneratedBootstrapPrompt(task) ? "" : task,
    ...session.tags,
    ...workItemIds,
  ];

  return corpus.some((value) => value.toLowerCase().includes(normalizedQuery));
}
