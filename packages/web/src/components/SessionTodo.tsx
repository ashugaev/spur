"use client";

import { useCallback, useEffect, useState } from "react";
import { usePoll } from "@/hooks/usePoll";
import type { PollOutcome } from "@/lib/poller";
import { isSpurTodoProjection, type SpurTodoActor, type SpurTodoProjection } from "@/lib/types";
import { FOCUS_RING_CLASS, HARD_WRAP_TEXT_CLASS } from "@/design/classes";

function actorLabel(actor: SpurTodoActor): string {
  if (actor.kind === "agent") return `${actor.agent} · ${actor.sessionId}`;
  if (actor.kind === "human") return `human · ${actor.origin}`;
  return `system · ${actor.source.replaceAll("_", " ")}`;
}

function reasonPreview(item: SpurTodoProjection["items"][number]): string {
  const transition = item.latestTransition;
  if (transition?.blocker?.kind === "human") {
    return `Human action: ${transition.blocker.requiredAction}`;
  }
  return transition?.reason ?? item.added.reason;
}

// An inherited item names its source before the reason.
function secondaryLine(item: SpurTodoProjection["items"][number]): string {
  if (!item.handoffFrom) return reasonPreview(item);
  return `From ${item.handoffFrom.sessionId} · ${reasonPreview(item)}`;
}

function statusGlyph(item: SpurTodoProjection["items"][number]): { glyph: string; label: string } {
  if (item.status === "cancelled" && item.handoffTo) return { glyph: "→", label: "handed off" };
  if (item.status === "completed") return { glyph: "✓", label: item.status };
  if (item.status === "cancelled") return { glyph: "×", label: item.status };
  if (item.status === "held") return { glyph: "Ⅱ", label: item.status };
  return { glyph: "○", label: item.status };
}

function TodoItem({
  item,
  overrides,
  compact = false,
}: {
  item: SpurTodoProjection["items"][number];
  overrides: SpurTodoProjection["finishOverrides"];
  compact?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const panelId = `todo-audit-${item.id}`;
  const status = statusGlyph(item);
  const held = item.status === "held";
  return (
    <li className="bg-[var(--color-bg-surface)]">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={panelId}
        className={`${FOCUS_RING_CLASS} flex w-full items-start gap-2 px-2.5 py-2 text-left`}
        onClick={() => setExpanded((value) => !value)}
      >
        <span
          role="img"
          aria-label={status.label}
          className={
            held ? "text-[var(--color-status-attention)]" : "text-[var(--color-text-secondary)]"
          }
        >
          {status.glyph}
        </span>
        <span className="min-w-0 flex-1">
          {!compact || expanded ? (
            <span className="block break-all font-mono text-[var(--color-text-secondary)]">
              {expanded ? item.id : item.id.slice(0, 8)}
            </span>
          ) : null}
          <span
            className={`block text-[var(--color-text-primary)] ${expanded || held ? HARD_WRAP_TEXT_CLASS : "min-w-0 truncate"}`}
          >
            {item.text}
          </span>
          {!compact || held || expanded ? (
            <span
              className={`block text-[var(--color-text-secondary)] ${held || expanded ? HARD_WRAP_TEXT_CLASS : "truncate"}`}
            >
              {secondaryLine(item)}
            </span>
          ) : null}
          {held &&
          item.latestTransition?.blocker?.kind === "human" &&
          item.latestTransition.reason ? (
            <span className={`block text-[var(--color-text-secondary)] ${HARD_WRAP_TEXT_CLASS}`}>
              {item.latestTransition.reason}
            </span>
          ) : null}
        </span>
      </button>
      {expanded ? (
        <div
          id={panelId}
          className="space-y-2 border-t border-[var(--color-border-subtle)] px-2.5 py-2 text-[var(--color-text-secondary)]"
        >
          {item.history.map((event) => (
            <div key={event.eventId}>
              <div className="uppercase tracking-meta text-[var(--color-text-secondary)]">
                {event.type.replaceAll("_", " ")} · {actorLabel(event.actor)} ·{" "}
                {new Date(event.at).toLocaleString()}
              </div>
              {event.reason ? <div className={HARD_WRAP_TEXT_CLASS}>{event.reason}</div> : null}
              {event.blocker?.kind === "human" ? (
                <div className={HARD_WRAP_TEXT_CLASS}>
                  Human action: {event.blocker.requiredAction}
                </div>
              ) : null}
            </div>
          ))}
          {overrides
            .filter((event) => event.unfinishedItemIds.includes(item.id))
            .map((event) => (
              <div
                key={event.eventId}
                className="border-t border-[var(--color-border-subtle)] pt-2"
              >
                <div className="uppercase tracking-meta text-[var(--color-text-secondary)]">
                  Completion override · {actorLabel(event.actor)} ·{" "}
                  {new Date(event.at).toLocaleString()}
                </div>
                <div className={HARD_WRAP_TEXT_CLASS}>{event.reason}</div>
              </div>
            ))}
        </div>
      ) : null}
    </li>
  );
}

export function SessionTodo({ sessionId }: { sessionId: string }) {
  const [projection, setProjection] = useState<SpurTodoProjection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [allExpanded, setAllExpanded] = useState(false);

  useEffect(() => {
    setProjection(null);
    setError(null);
    setAllExpanded(false);
  }, [sessionId]);

  const load = useCallback(
    async (signal: AbortSignal): Promise<PollOutcome> => {
      try {
        const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/todo`, {
          cache: "no-store",
          signal,
        });
        const payload = (await response.json()) as unknown;
        if (!response.ok) {
          const message =
            payload && typeof payload === "object" && "error" in payload
              ? String((payload as { error: unknown }).error)
              : "Failed to read Spur ToDo";
          throw new Error(message);
        }
        if (!isSpurTodoProjection(payload)) throw new Error("Invalid ToDo response from Spur");
        if (!signal.aborted) {
          setProjection(payload);
          setError(null);
        }
        return "ok";
      } catch (loadError) {
        if (signal.aborted) return "ok";
        setError(loadError instanceof Error ? loadError.message : "Failed to read Spur ToDo");
        return "failed";
      }
    },
    [sessionId],
  );
  usePoll(load, 5_000);

  const resolved = projection ? projection.counts.completed + projection.counts.cancelled : 0;
  const currentItem = projection?.items.find((item) => item.status === "open");
  const visibleItems =
    projection?.items.filter(
      (item) => item.status === "held" || (!allExpanded && item === currentItem),
    ) ?? [];
  return (
    <section aria-labelledby="session-todo-heading">
      <h2
        id="session-todo-heading"
        className="flex items-center gap-2 py-2 text-label font-bold uppercase tracking-caps text-[var(--color-text-secondary)]"
      >
        ToDo
        <div className="flex-1 border-t border-[var(--color-border-subtle)]" />
      </h2>
      {!projection && !error ? (
        <div
          aria-label="Loading ToDo"
          className="h-14 animate-pulse border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)]"
        />
      ) : null}
      {error ? (
        <div
          role="alert"
          className={`border border-[var(--color-status-error)] bg-[var(--color-bg-surface)] px-3 py-2 text-[var(--color-status-error)] ${HARD_WRAP_TEXT_CLASS}`}
        >
          ToDo unavailable: {error}
        </div>
      ) : null}
      {projection && projection.items.length === 0 ? (
        <p className="border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-3 py-2 text-[var(--color-text-tertiary)]">
          No ToDo items yet.
        </p>
      ) : null}
      {projection && projection.items.length > 0 ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2 border-b border-[var(--color-border-default)] py-2">
            <div
              aria-label={`${resolved} of ${projection.counts.total} ToDo items resolved`}
              className="shrink-0 font-bold text-[var(--color-text-primary)]"
              title={`${projection.counts.total === 0 ? 0 : Math.round((resolved / projection.counts.total) * 100)}% resolved`}
            >
              {resolved}/{projection.counts.total}
            </div>
            <div className="flex flex-wrap gap-2 uppercase tracking-meta text-[var(--color-text-secondary)]">
              {projection.counts.open > 0 ? <span>{projection.counts.open} open</span> : null}
              {projection.counts.held > 0 ? <span>{projection.counts.held} held</span> : null}
              <span>{resolved} resolved</span>
            </div>
          </div>
          {visibleItems.length > 0 ? (
            <ol
              aria-label="Spur ToDo items"
              className="divide-y divide-[var(--color-border-subtle)] border border-[var(--color-border-default)]"
            >
              {visibleItems.map((item) => (
                <TodoItem
                  key={`${sessionId}:${item.id}`}
                  item={item}
                  overrides={projection.finishOverrides}
                  compact
                />
              ))}
            </ol>
          ) : null}
          <details
            key={sessionId}
            open={allExpanded}
            onToggle={(event) => setAllExpanded(event.currentTarget.open)}
          >
            <summary
              className={`${FOCUS_RING_CLASS} cursor-pointer py-2 uppercase tracking-meta text-[var(--color-text-secondary)]`}
            >
              All tasks &amp; history
            </summary>
            {allExpanded ? (
              <ol
                aria-label="All Spur ToDo items"
                className="divide-y divide-[var(--color-border-subtle)] border border-[var(--color-border-default)]"
              >
                {projection.items
                  .filter((item) => item.status !== "held")
                  .map((item) => (
                    <TodoItem
                      key={`${sessionId}:${item.id}`}
                      item={item}
                      overrides={projection.finishOverrides}
                    />
                  ))}
              </ol>
            ) : null}
          </details>
        </div>
      ) : null}
    </section>
  );
}
