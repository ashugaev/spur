"use client";

import { useEffect, useRef } from "react";
import { MarkdownMessage } from "@/components/MarkdownMessage";
import { HARD_WRAP_TEXT_CLASS } from "@/design/classes";
import type { ConversationMessage, TranscriptEntry } from "@/lib/types";

export interface ConversationViewProps {
  entries: TranscriptEntry[];
  messages: ConversationMessage[];
  durationMs: number;
  /** True when the agent is actively producing a response right now. */
  isWorking: boolean;
}

const MAX_MESSAGE_CHARS = 500;
const MAX_TOOL_CHARS = 240;
const MAX_REASONING_CHARS = 400;

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return "<1m";
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function entryTailKey(entry: TranscriptEntry): string {
  switch (entry.kind) {
    case "message":
      return `message:${entry.timestampMs ?? ""}:${entry.role}:${entry.text}`;
    case "tool":
      return `tool:${entry.timestampMs ?? ""}:${entry.name}:${entry.callId ?? ""}`;
    case "reasoning":
      return `reasoning:${entry.timestampMs ?? ""}:${entry.text}`;
    case "question":
      return `question:${entry.timestampMs ?? ""}:${entry.header}`;
  }
}

function messagesAsEntries(messages: ConversationMessage[]): TranscriptEntry[] {
  return messages.map((message) => ({
    kind: "message",
    role: message.role,
    text: message.text,
    timestampMs: message.timestampMs,
  }));
}

function MessageEntryRow({ entry }: { entry: Extract<TranscriptEntry, { kind: "message" }> }) {
  return (
    <div
      className={`min-w-0 max-w-[85%] px-3 py-2 ${
        entry.role === "user"
          ? "ml-auto border border-[var(--color-accent)]/30 bg-[var(--color-accent)]/10 text-[var(--color-text-primary)]"
          : "mr-auto border border-[var(--color-border-default)] text-[var(--color-text-secondary)]"
      }`}
    >
      <MarkdownMessage text={truncate(entry.text, MAX_MESSAGE_CHARS)} />
    </div>
  );
}

function ToolEntryRow({ entry }: { entry: Extract<TranscriptEntry, { kind: "tool" }> }) {
  const inputSummary = entry.inputSummary?.trim();
  const output = entry.output?.trim();
  return (
    <div className="min-w-0 max-w-[95%] border border-[var(--color-border-subtle)] bg-[var(--color-bg-elevated)]/60 px-2 py-1 font-mono text-[10px] text-[var(--color-text-tertiary)]">
      <div className="uppercase tracking-[0.08em]">{entry.name}</div>
      {inputSummary ? (
        <div className={`mt-0.5 ${HARD_WRAP_TEXT_CLASS}`}>{truncate(inputSummary, MAX_TOOL_CHARS)}</div>
      ) : null}
      {output ? (
        <div className={`mt-0.5 ${HARD_WRAP_TEXT_CLASS} opacity-80`}>
          {truncate(output, MAX_TOOL_CHARS)}
        </div>
      ) : null}
    </div>
  );
}

function ReasoningEntryRow({ entry }: { entry: Extract<TranscriptEntry, { kind: "reasoning" }> }) {
  return (
    <div
      className={`mr-auto min-w-0 max-w-[85%] px-3 py-1.5 italic text-[var(--color-text-tertiary)] ${HARD_WRAP_TEXT_CLASS}`}
    >
      {truncate(entry.text, MAX_REASONING_CHARS)}
    </div>
  );
}

function QuestionEntryRow({ entry }: { entry: Extract<TranscriptEntry, { kind: "question" }> }) {
  return (
    <div className="min-w-0 border border-[var(--color-status-attention)]/50 bg-[var(--color-bg-elevated)] px-3 py-2">
      <div className="text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--color-status-attention)]">
        {entry.header}
      </div>
      <div className={`mt-1 ${HARD_WRAP_TEXT_CLASS} text-[var(--color-text-primary)]`}>
        {entry.prompt}
      </div>
      {entry.options && entry.options.length > 0 ? (
        <ol className="mt-2 space-y-1">
          {entry.options.map((option) => (
            <li key={option.index} className="text-[var(--color-text-secondary)]">
              <span className="font-mono text-[var(--color-text-tertiary)]">{option.index}.</span>{" "}
              {option.label}
            </li>
          ))}
        </ol>
      ) : null}
      <div className="mt-2 text-[10px] uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
        Reply from the message box below to answer
      </div>
    </div>
  );
}

function ConversationEntryRow({ entry }: { entry: TranscriptEntry }) {
  switch (entry.kind) {
    case "message":
      return <MessageEntryRow entry={entry} />;
    case "tool":
      return <ToolEntryRow entry={entry} />;
    case "reasoning":
      return <ReasoningEntryRow entry={entry} />;
    case "question":
      return <QuestionEntryRow entry={entry} />;
  }
}

export function ConversationView({ entries, messages, durationMs, isWorking }: ConversationViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastTailRef = useRef<string | null>(null);

  const items = entries.length > 0 ? entries : messagesAsEntries(messages);

  useEffect(() => {
    const last = items[items.length - 1];
    const tailKey = isWorking
      ? `pending:${last ? entryTailKey(last) : "none"}`
      : last && last.kind === "message" && last.role === "assistant"
        ? `assistant:${entryTailKey(last)}`
        : null;
    if (!tailKey || tailKey === lastTailRef.current) {
      return;
    }
    lastTailRef.current = tailKey;
    const el = scrollRef.current;
    if (!el) return;
    if (typeof el.scrollTo === "function") {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      return;
    }
    el.scrollTop = el.scrollHeight;
  }, [items, isWorking]);

  if (items.length === 0) {
    return null;
  }

  return (
    <section>
      <h2 className="flex items-center gap-2 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--color-text-tertiary)]">
        Dialog
        <div className="flex-1 border-t border-[var(--color-border-subtle)]" />
        {durationMs > 0 ? (
          <span className="font-normal normal-case tracking-normal">
            {formatDuration(durationMs)}
          </span>
        ) : null}
      </h2>
      <div
        ref={scrollRef}
        className="flex max-h-80 flex-col gap-2 overflow-y-auto border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] p-3"
      >
        {items.map((entry, index) => (
          <ConversationEntryRow key={`${entry.kind}-${index}`} entry={entry} />
        ))}
        {isWorking ? (
          <div
            aria-label="Assistant is responding"
            className="mr-auto min-w-0 max-w-[85%] border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 text-[var(--color-text-tertiary)]"
          >
            <div className={`${HARD_WRAP_TEXT_CLASS} animate-pulse tracking-[0.3em]`}>...</div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
