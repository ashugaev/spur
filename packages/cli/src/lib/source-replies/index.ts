import { jiraSourceReplyAdapter } from "./jira.js";
import { telegramSourceReplyAdapter } from "./telegram.js";
import type { SourceReplyAdapter } from "./types.js";

const sourceReplyRegistry = new Map<string, SourceReplyAdapter>();

export function registerSourceReplyAdapter(adapter: SourceReplyAdapter): void {
  sourceReplyRegistry.set(adapter.source, adapter);
}

export function getSourceReplyAdapter(source: string): SourceReplyAdapter | undefined {
  return sourceReplyRegistry.get(source);
}

export function unregisterSourceReplyAdapter(source: string): void {
  sourceReplyRegistry.delete(source);
}

registerSourceReplyAdapter(jiraSourceReplyAdapter);
registerSourceReplyAdapter(telegramSourceReplyAdapter);
