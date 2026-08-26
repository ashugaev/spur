"use client";

import { useState } from "react";
import { INPUT_CLASS } from "@/design/classes";

type TodoOverrideDialogProps = (
  | { empty: true }
  | { empty?: false; openCount: number; heldCount: number }
) & {
  busy: boolean;
  onCancel: () => void;
  onSubmit: (reason: string) => void;
};

export function TodoOverrideDialog(props: TodoOverrideDialogProps) {
  const { busy, onCancel, onSubmit } = props;
  const [reason, setReason] = useState("");
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-[var(--color-modal-backdrop)] p-4"
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="todo-override-title"
        className="w-full max-w-lg border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] p-4"
      >
        <h2
          id="todo-override-title"
          className="font-bold uppercase tracking-[0.12em] text-[var(--color-text-primary)]"
        >
          {props.empty ? "Empty ToDo" : "Unfinished ToDo"}
        </h2>
        <p className="py-3 text-[var(--color-text-secondary)]">
          {props.empty
            ? "This session recorded no ToDo items. Completing keeps the ledger empty in audit history."
            : `${props.openCount} open and ${props.heldCount} held items remain. Completing keeps them unfinished in audit history.`}
        </p>
        <label
          className="block uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]"
          htmlFor="todo-override-reason"
        >
          Override reason
        </label>
        <textarea
          id="todo-override-reason"
          className={`${INPUT_CLASS} mt-2 min-h-24 w-full`}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            className="border border-[var(--color-border-default)] px-2 py-1.5 font-bold uppercase"
            disabled={busy}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="bg-[var(--color-text-primary)] px-2 py-1.5 font-bold uppercase text-[var(--color-bg-base)] disabled:opacity-50"
            disabled={busy || !reason.trim()}
            onClick={() => onSubmit(reason.trim())}
          >
            Complete anyway
          </button>
        </div>
      </div>
    </div>
  );
}
