"use client";

import { useEffect, useRef, useState } from "react";
import { MarkdownMessage } from "@/components/MarkdownMessage";
import { HARD_WRAP_TEXT_CLASS } from "@/design/classes";
import type { ConversationMessage, TranscriptEntry } from "@/lib/types";

export interface ConversationViewProps {
  entries: TranscriptEntry[];
  messages: ConversationMessage[];
  durationMs: number;
  /** True when the agent is actively producing a response right now. */
  isWorking: boolean;
  /** Agent runtime for this session; only "claude" supports interactive answering. */
  agent: string;
  /** Selects and submits a single-select AskUserQuestion option via a tmux keystroke. */
  onAnswer: (optionIndex: number) => Promise<void> | void;
}

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
      className={`min-w-0 max-w-[85%] px-3 py-2 text-[var(--color-text-primary)] ${
        entry.role === "user"
          ? "ml-auto border border-[var(--color-accent)]/30 bg-[var(--color-accent)]/10"
          : "mr-auto border border-[var(--color-border-default)]"
      }`}
    >
      <MarkdownMessage text={entry.text} />
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
        <div className={`mt-0.5 ${HARD_WRAP_TEXT_CLASS}`}>
          <span className="text-[10px] font-bold text-[var(--color-text-tertiary)]">in:</span>{" "}
          {truncate(inputSummary, MAX_TOOL_CHARS)}
        </div>
      ) : null}
      {output ? (
        <div className={`mt-0.5 ${HARD_WRAP_TEXT_CLASS} opacity-80`}>
          <span className="text-[10px] font-bold text-[var(--color-text-tertiary)]">out:</span>{" "}
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

function questionEntryKey(entry: Extract<TranscriptEntry, { kind: "question" }>): string {
  return `${entry.timestampMs ?? ""}:${entry.header}`;
}

function QuestionEntryRow({
  entry,
  agent,
  isAnswered,
  onSelectOption,
}: {
  entry: Extract<TranscriptEntry, { kind: "question" }>;
  agent: string;
  isAnswered: boolean;
  onSelectOption: (optionIndex: number) => void;
}) {
  const canAnswerInline =
    agent === "claude" && !entry.multiSelect && (entry.options?.length ?? 0) > 0;

  return (
    <div
      className="min-w-0 border border-[var(--color-status-attention)] bg-[var(--color-status-attention)]/10 px-3 py-2"
      role="alert"
    >
      <div className="text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--color-status-attention)]">
        {entry.header}
      </div>
      <div className={`mt-1 ${HARD_WRAP_TEXT_CLASS} text-[var(--color-text-primary)]`}>
        {entry.prompt}
      </div>
      {entry.options && entry.options.length > 0 ? (
        canAnswerInline ? (
          <div aria-label="Answer options" className="mt-2 flex flex-col gap-1">
            {entry.options.map((option) => (
              <button
                key={option.index}
                type="button"
                disabled={isAnswered}
                onClick={() => onSelectOption(option.index)}
                className="border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] px-2 py-1 text-left text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-text-primary)] disabled:cursor-not-allowed disabled:opacity-60"
              >
                <span className="font-mono text-[var(--color-text-tertiary)]">
                  {option.index}.
                </span>{" "}
                {option.label}
              </button>
            ))}
          </div>
        ) : (
          <ol aria-label="Answer options" className="mt-2 space-y-1">
            {entry.options.map((option) => (
              <li key={option.index} className="text-[var(--color-text-secondary)]">
                <span className="font-mono text-[var(--color-text-tertiary)]">
                  {option.index}.
                </span>{" "}
                {option.label}
              </li>
            ))}
          </ol>
        )
      ) : null}
      {canAnswerInline ? (
        <div className="mt-2 text-[10px] uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
          {isAnswered ? "Answering…" : "Click an option to answer"}
        </div>
      ) : (
        <div className="mt-2 text-[10px] uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
          Reply from the message box below to answer
        </div>
      )}
    </div>
  );
}

function ConversationEntryRow({
  entry,
  agent,
  isQuestionAnswered,
  onSelectQuestionOption,
}: {
  entry: TranscriptEntry;
  agent: string;
  isQuestionAnswered: (entry: Extract<TranscriptEntry, { kind: "question" }>) => boolean;
  onSelectQuestionOption: (
    entry: Extract<TranscriptEntry, { kind: "question" }>,
    optionIndex: number,
  ) => void;
}) {
  switch (entry.kind) {
    case "message":
      return <MessageEntryRow entry={entry} />;
    case "tool":
      return <ToolEntryRow entry={entry} />;
    case "reasoning":
      return <ReasoningEntryRow entry={entry} />;
    case "question":
      return (
        <QuestionEntryRow
          entry={entry}
          agent={agent}
          isAnswered={isQuestionAnswered(entry)}
          onSelectOption={(optionIndex) => onSelectQuestionOption(entry, optionIndex)}
        />
      );
  }
}

export function ConversationView({
  entries,
  messages,
  durationMs,
  isWorking,
  agent,
  onAnswer,
}: ConversationViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastTailRef = useRef<string | null>(null);
  const [answeredKeys, setAnsweredKeys] = useState<Set<string>>(new Set());

  const items = entries.length > 0 ? entries : messagesAsEntries(messages);

  const handleSelectQuestionOption = (
    entry: Extract<TranscriptEntry, { kind: "question" }>,
    optionIndex: number,
  ) => {
    const key = questionEntryKey(entry);
    setAnsweredKeys((prev) => new Set(prev).add(key));
    void onAnswer(optionIndex);
  };

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

  if (items.length === 0 && !isWorking) {
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
          <ConversationEntryRow
            key={`${entry.kind}-${index}`}
            entry={entry}
            agent={agent}
            isQuestionAnswered={(questionEntry) => answeredKeys.has(questionEntryKey(questionEntry))}
            onSelectQuestionOption={handleSelectQuestionOption}
          />
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
