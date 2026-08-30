"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { MarkdownMessage } from "@/components/MarkdownMessage";
import { Spinner } from "@/components/icons/Spinner";
import { HARD_WRAP_TEXT_CLASS } from "@/design/classes";
import type { ConversationMessage, TranscriptEntry } from "@/lib/types";

// Scroll fetch/resume thresholds, in pixels from the edge of the dialog's
// scroll container.
const SCROLL_EDGE_THRESHOLD_PX = 64;

export interface ConversationViewProps {
  entries: TranscriptEntry[];
  messages: ConversationMessage[];
  durationMs: number;
  /** Absolute index of `entries[0]` within the full transcript. Defaults to 0. */
  startIndex?: number;
  /** True when there are older entries before `startIndex`. */
  hasMore?: boolean;
  /** True while an older page fetch triggered by scroll-to-top is in flight. */
  isLoadingOlder?: boolean;
  /** True once the user has scrolled back to an older page (parent's fromIndex is set). */
  hasOlderLoaded?: boolean;
  /** Fetches the next older page. Called on scroll-to-top when `hasMore`. */
  onLoadOlder?: () => void;
  /** Resumes following the live tail. Called on scroll-to-bottom when `hasOlderLoaded`. */
  onResumeTail?: () => void;
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

/** Per-question answer lifecycle. `optionLabel` is set once a choice is made (pending/answered/error). */
type QuestionAnswerState =
  | { status: "idle" }
  | { status: "pending"; optionLabel: string }
  | { status: "answered"; optionLabel: string }
  | { status: "error"; optionLabel: string };

const OPTION_BUTTON_CLASS =
  "border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] px-2 py-1 text-left text-[var(--color-text-secondary)] outline-none transition-colors hover:border-[var(--color-accent)] hover:bg-[var(--color-hover-overlay)] hover:text-[var(--color-text-primary)] focus-visible:border-[var(--color-accent)] focus-visible:text-[var(--color-text-primary)] disabled:cursor-not-allowed disabled:opacity-50";

function QuestionEntryRow({
  entry,
  agent,
  answerState,
  onSelectOption,
}: {
  entry: Extract<TranscriptEntry, { kind: "question" }>;
  agent: string;
  answerState: QuestionAnswerState;
  onSelectOption: (optionIndex: number, optionLabel: string) => void;
}) {
  const canAnswerInline =
    agent === "claude" && !entry.multiSelect && (entry.options?.length ?? 0) > 0;
  const isPending = answerState.status === "pending";
  const isAnswered = answerState.status === "answered";
  const isError = answerState.status === "error";
  const buttonsDisabled = isPending || isAnswered;

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
                disabled={buttonsDisabled}
                onClick={() => onSelectOption(option.index, option.label)}
                className={OPTION_BUTTON_CLASS}
              >
                <span className="font-mono text-[var(--color-text-tertiary)]">{option.index}.</span>{" "}
                <span className={HARD_WRAP_TEXT_CLASS}>{option.label}</span>
              </button>
            ))}
          </div>
        ) : (
          <ol aria-label="Answer options" className="mt-2 space-y-1">
            {entry.options.map((option) => (
              <li key={option.index} className="text-[var(--color-text-secondary)]">
                <span className="font-mono text-[var(--color-text-tertiary)]">{option.index}.</span>{" "}
                {option.label}
              </li>
            ))}
          </ol>
        )
      ) : null}
      {canAnswerInline ? (
        <div
          className={`mt-2 text-[10px] uppercase tracking-[0.08em] ${
            isAnswered
              ? "text-[var(--color-status-ready)]"
              : isError
                ? "text-[var(--color-status-error)]"
                : "text-[var(--color-text-tertiary)]"
          }`}
        >
          {isAnswered ? (
            `Answered: ${answerState.optionLabel}`
          ) : isError ? (
            "Couldn't send — try again"
          ) : isPending ? (
            <span aria-label="Sending answer" className="inline-flex" role="status">
              <Spinner className="h-3 w-3" strokeWidth={1.5} />
            </span>
          ) : (
            "Click an option to answer"
          )}
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
  getQuestionAnswerState,
  onSelectQuestionOption,
}: {
  entry: TranscriptEntry;
  agent: string;
  getQuestionAnswerState: (
    entry: Extract<TranscriptEntry, { kind: "question" }>,
  ) => QuestionAnswerState;
  onSelectQuestionOption: (
    entry: Extract<TranscriptEntry, { kind: "question" }>,
    optionIndex: number,
    optionLabel: string,
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
          answerState={getQuestionAnswerState(entry)}
          onSelectOption={(optionIndex, optionLabel) =>
            onSelectQuestionOption(entry, optionIndex, optionLabel)
          }
        />
      );
  }
}

export function ConversationView({
  entries,
  messages,
  durationMs,
  startIndex = 0,
  hasMore,
  isLoadingOlder = false,
  hasOlderLoaded = false,
  onLoadOlder = () => {},
  onResumeTail = () => {},
  isWorking,
  agent,
  onAnswer,
}: ConversationViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastTailRef = useRef<string | null>(null);
  const [answerStates, setAnswerStates] = useState<Record<string, QuestionAnswerState>>({});
  // Captured just before an older page is prepended so the post-render layout
  // effect can restore the user's read position instead of letting it jump.
  const pendingScrollAnchorRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);

  const items = entries.length > 0 ? entries : messagesAsEntries(messages);

  const handleSelectQuestionOption = (
    entry: Extract<TranscriptEntry, { kind: "question" }>,
    optionIndex: number,
    optionLabel: string,
  ) => {
    const key = questionEntryKey(entry);
    setAnswerStates((prev) => ({ ...prev, [key]: { status: "pending", optionLabel } }));
    (async () => {
      try {
        await onAnswer(optionIndex);
        setAnswerStates((prev) => ({ ...prev, [key]: { status: "answered", optionLabel } }));
      } catch {
        setAnswerStates((prev) => ({ ...prev, [key]: { status: "error", optionLabel } }));
      }
    })();
  };

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollTop < SCROLL_EDGE_THRESHOLD_PX && hasMore === true && !isLoadingOlder) {
      pendingScrollAnchorRef.current = { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop };
      onLoadOlder();
      return;
    }
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom < SCROLL_EDGE_THRESHOLD_PX && hasOlderLoaded) {
      onResumeTail();
    }
  };

  // Scroll anchoring for a load-older prepend: restore the user's read
  // position relative to the content that was already on screen, rather than
  // letting the new (longer) list push it down.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const anchor = pendingScrollAnchorRef.current;
    if (!el || anchor === null) return;
    pendingScrollAnchorRef.current = null;
    el.scrollTop = anchor.scrollTop + (el.scrollHeight - anchor.scrollHeight);
  }, [startIndex]);

  useEffect(() => {
    if (hasOlderLoaded) return;
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
  }, [items, isWorking, hasOlderLoaded]);

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
        onScroll={handleScroll}
        data-testid="conversation-scroll"
        className="flex max-h-80 flex-col gap-2 overflow-y-auto overflow-x-hidden border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] p-3"
      >
        {isLoadingOlder ? (
          <div
            aria-label="Loading older messages"
            className="mx-auto flex items-center gap-1.5 py-1 text-[var(--color-text-tertiary)]"
          >
            <Spinner className="h-3 w-3" strokeWidth={1.5} />
            <span className="text-[10px] uppercase tracking-[0.08em]">Loading older</span>
          </div>
        ) : null}
        {items.map((entry, index) => (
          <ConversationEntryRow
            key={`${startIndex + index}-${entry.kind}`}
            entry={entry}
            agent={agent}
            getQuestionAnswerState={(questionEntry) =>
              answerStates[questionEntryKey(questionEntry)] ?? { status: "idle" }
            }
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
