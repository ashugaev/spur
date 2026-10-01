"use client";

import { useEffect, useRef } from "react";
import { IconCloseButton } from "@/components/IconCloseButton";
import { CloseIcon } from "@/components/icons/CloseIcon";

interface TitleEditDialogProps {
  draft: string;
  saving: boolean;
  onDraftChange: (draft: string) => void;
  onSave: () => void;
  onCancel: () => void;
}

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function TitleEditDialog({
  draft,
  saving,
  onDraftChange,
  onSave,
  onCancel,
}: TitleEditDialogProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      previouslyFocused?.focus();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) {
        onCancel();
        return;
      }
      if (event.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusables = panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (!first || !last) return;
      const active = document.activeElement as HTMLElement | null;
      if (event.shiftKey) {
        if (active === first || !panel.contains(active)) {
          event.preventDefault();
          last.focus();
        }
        return;
      }
      if (active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel, saving]);

  return (
    <div
      aria-labelledby="title-edit-dialog-title"
      aria-modal="true"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-[var(--color-modal-backdrop)] p-4"
      role="dialog"
      onClick={(event) => {
        if (event.target === event.currentTarget && !saving) onCancel();
      }}
    >
      <div
        ref={panelRef}
        className="w-[min(22rem,calc(100vw-2rem))] border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] p-4 shadow-[0_8px_24px_var(--color-shadow-modal-sm)]"
      >
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2
            className="font-bold uppercase text-[var(--color-text-primary)]"
            id="title-edit-dialog-title"
          >
            Edit title
          </h2>
          <IconCloseButton disabled={saving} label="Cancel title edit" onClick={onCancel} />
        </div>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            onSave();
          }}
        >
          <label className="sr-only" htmlFor="session-title-edit">
            Session title
          </label>
          <div className="flex items-center gap-1 border border-[var(--color-input-border)] bg-[var(--color-input-bg)] py-1 pl-2.5 pr-1 transition focus-within:border-[var(--color-accent)]">
            <input
              id="session-title-edit"
              ref={inputRef}
              className="min-w-0 flex-1 border-none bg-transparent py-1 font-bold uppercase text-[var(--color-input-text)] outline-none"
              disabled={saving}
              onChange={(event) => onDraftChange(event.target.value)}
              value={draft}
            />
            {draft.length > 0 ? (
              <button
                aria-label="Clear title input"
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center bg-transparent text-[var(--color-text-primary)] transition hover:bg-[var(--color-hover-overlay)]"
                disabled={saving}
                onClick={() => {
                  onDraftChange("");
                  inputRef.current?.focus();
                }}
                type="button"
              >
                <CloseIcon />
              </button>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              className="border border-[var(--color-accent)] bg-[var(--color-accent)] px-3 py-1.5 font-bold uppercase text-[var(--color-text-inverse)] transition hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
              disabled={saving}
              type="submit"
            >
              Save
            </button>
            <button
              className="border border-[var(--color-border-strong)] px-3 py-1.5 font-bold uppercase text-[var(--color-text-secondary)] transition hover:bg-[var(--color-hover-overlay)] hover:text-[var(--color-text-primary)] disabled:opacity-50"
              disabled={saving}
              onClick={onCancel}
              type="button"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
