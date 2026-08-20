"use client";

import { useEffect, useState } from "react";
import { isSpurTodoProjection, type SpurTodoActor, type SpurTodoProjection } from "@/lib/types";

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

export function SessionTodo({ sessionId }: { sessionId: string }) {
  const [projection, setProjection] = useState<SpurTodoProjection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    let active = true;
    setProjection(null);
    setError(null);
    setExpanded(new Set());
    const load = async () => {
      try {
        const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/todo`, {
          cache: "no-store",
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
        if (active) {
          setProjection(payload);
          setError(null);
        }
      } catch (loadError) {
        if (active)
          setError(loadError instanceof Error ? loadError.message : "Failed to read Spur ToDo");
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 5_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [sessionId]);

  const resolved = projection ? projection.counts.completed + projection.counts.cancelled : 0;
  return (
    <section aria-labelledby="session-todo-heading">
      <h2
        id="session-todo-heading"
        className="flex items-center gap-2 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--color-text-tertiary)]"
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
          className="border border-[var(--color-status-error)] bg-[var(--color-bg-surface)] px-3 py-2 text-[var(--color-status-error)]"
        >
          ToDo unavailable: {error}
        </div>
      ) : null}
      {projection ? (
        <div className="space-y-2">
          <div className="flex items-center gap-3 border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-3 py-2">
            <div
              aria-label={`${resolved} of ${projection.counts.total} ToDo items resolved`}
              className="grid h-8 w-8 shrink-0 place-items-center border border-[var(--color-border-default)] font-bold text-[var(--color-text-primary)]"
              title={`${projection.counts.total === 0 ? 0 : Math.round((resolved / projection.counts.total) * 100)}% resolved`}
            >
              {resolved}/{projection.counts.total}
            </div>
            <div className="flex flex-wrap gap-3 uppercase tracking-[0.08em] text-[var(--color-text-secondary)]">
              {projection.counts.open > 0 ? <span>{projection.counts.open} open</span> : null}
              {projection.counts.held > 0 ? <span>{projection.counts.held} held</span> : null}
              <span>{resolved} resolved</span>
            </div>
          </div>
          <ol
            aria-label="Spur ToDo items"
            className="divide-y divide-[var(--color-border-subtle)] border border-[var(--color-border-default)]"
          >
            {projection.items.map((item) => {
              const isExpanded = expanded.has(item.id);
              const panelId = `todo-audit-${item.id}`;
              const overrides = projection.finishOverrides.filter((event) =>
                event.unfinishedItemIds.includes(item.id),
              );
              return (
                <li key={item.id} className="bg-[var(--color-bg-surface)]">
                  <button
                    type="button"
                    aria-expanded={isExpanded}
                    aria-controls={panelId}
                    className="grid w-full grid-cols-[auto_auto_minmax(0,1fr)] items-start gap-2 px-3 py-2 text-left"
                    onClick={() =>
                      setExpanded((current) => {
                        const next = new Set(current);
                        if (next.has(item.id)) next.delete(item.id);
                        else next.add(item.id);
                        return next;
                      })
                    }
                  >
                    <span
                      aria-label={item.status}
                      className="uppercase text-[var(--color-text-tertiary)]"
                    >
                      {item.status === "completed"
                        ? "✓"
                        : item.status === "cancelled"
                          ? "×"
                          : item.status === "held"
                            ? "Ⅱ"
                            : "○"}
                    </span>
                    <span className="font-mono text-[var(--color-text-tertiary)]">
                      {item.id.slice(0, 8)}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[var(--color-text-primary)]">{item.text}</span>
                      <span className="block truncate text-[var(--color-text-secondary)]">
                        {reasonPreview(item)}
                      </span>
                    </span>
                  </button>
                  {isExpanded ? (
                    <div
                      id={panelId}
                      className="space-y-2 border-t border-[var(--color-border-subtle)] px-3 py-2 text-[var(--color-text-secondary)]"
                    >
                      {item.history.map((event) => (
                        <div key={event.eventId}>
                          <div className="uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
                            {event.type.replaceAll("_", " ")} · {actorLabel(event.actor)} ·{" "}
                            {new Date(event.at).toLocaleString()}
                          </div>
                          {event.reason ? <div>{event.reason}</div> : null}
                          {event.blocker?.kind === "human" ? (
                            <div>Human action: {event.blocker.requiredAction}</div>
                          ) : null}
                        </div>
                      ))}
                      {overrides.map((event) => (
                        <div
                          key={event.eventId}
                          className="border-t border-[var(--color-border-subtle)] pt-2"
                        >
                          <div className="uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
                            Completion override · {actorLabel(event.actor)} ·{" "}
                            {new Date(event.at).toLocaleString()}
                          </div>
                          <div>{event.reason}</div>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ol>
        </div>
      ) : null}
    </section>
  );
}
