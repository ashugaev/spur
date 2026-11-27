"use client";

import { useEffect, useId, useRef, useState } from "react";
import {
  ArtifactList,
  DEFAULT_ARTIFACT_SORT,
  type ArtifactSortState,
} from "@/components/ArtifactList";
import { SECTION_CLASS, SECTION_HEADING_CLASS } from "@/components/cron-job-classes";
import { Spinner } from "@/components/icons/Spinner";
import { TrashIcon } from "@/components/icons/TrashIcon";
import {
  clearCronStorage,
  cronStorageFileUrl,
  fetchCronStorage,
  saveCronStorageNote,
} from "@/lib/cron-jobs";
import {
  DANGER_BUTTON_CLASS,
  HARD_WRAP_TEXT_CLASS,
  ICON_BUTTON_CLASS,
  INPUT_CLASS,
  SECONDARY_BUTTON_CLASS,
} from "@/design/classes";
import { formatBytes, formatRelativeTime } from "@/lib/format";
import type { CronStorageView } from "@/lib/types";

type LoadState =
  | { status: "pending" }
  | { status: "error"; message: string }
  | { status: "ready"; view: CronStorageView };

const SECONDARY_TEXT = "text-[var(--color-text-secondary)]";
const ERROR_TEXT = "text-[var(--color-status-error)]";
const TRASH_BUTTON_CLASS = `${ICON_BUTTON_CLASS} h-7 w-7 text-[var(--color-text-secondary)] border-[var(--color-border-default)]! hover:border-[var(--color-status-error)]! focus-visible:border-[var(--color-status-error)]!`;
// Restyles ArtifactList through descendant variants; the list component stays unchanged.
const FILES_CLASS = [
  "[&_thead_tr]:border-[var(--color-border-subtle)]",
  "[&_th>button]:px-2 [&_th>button]:py-1 [&_th>button]:tracking-meta [&_th>button]:whitespace-nowrap",
  "[&_th:first-child>button]:pl-0",
  "[&_th:last-child]:py-1 [&_th:last-child]:pl-2 [&_th:last-child]:pr-0 [&_th:last-child]:tracking-meta [&_th:last-child]:whitespace-nowrap",
  "[&_td]:px-2 [&_td]:py-1.5 [&_td:first-child]:pl-0 [&_td:last-child]:pr-0",
  "[&_tbody_tr:last-child]:border-b-0",
  "[&_td_a]:border-transparent [&_td_button]:border-transparent",
].join(" ");

function countText(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function confirmText(view: CronStorageView): string {
  const parts = [
    ...(view.note !== "" ? ["note"] : []),
    ...(view.files.length > 0 ? [countText(view.files.length, "file")] : []),
  ];
  return `Delete ${parts.join(" and ")}?`;
}

export function CronStorageSection({
  projectId,
  triggerId,
}: {
  projectId: string;
  triggerId: string;
}) {
  const noteId = useId();
  const [load, setLoad] = useState<LoadState>({ status: "pending" });
  const [noteOpen, setNoteOpen] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [sort, setSort] = useState<ArtifactSortState>(DEFAULT_ARTIFACT_SORT);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const trashRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  // Keyed header branches remount on confirm toggle; the target resolves after render.
  const returnFocusRef = useRef<typeof toggleRef | null>(null);

  useEffect(() => {
    if (confirming) {
      cancelRef.current?.focus();
      return;
    }
    returnFocusRef.current?.current?.focus();
    returnFocusRef.current = null;
  }, [confirming]);

  useEffect(() => {
    const controller = new AbortController();
    fetchCronStorage(projectId, triggerId, controller.signal).then(
      (view) => {
        if (!controller.signal.aborted) setLoad({ status: "ready", view });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setLoad({
          status: "error",
          message: error instanceof Error ? error.message : "Could not load storage.",
        });
      },
    );
    return () => controller.abort();
  }, [projectId, triggerId]);

  const run = async (request: () => Promise<CronStorageView>): Promise<boolean> => {
    setBusy(true);
    setActionError(null);
    try {
      setLoad({ status: "ready", view: await request() });
      setDraft(null);
      return true;
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Storage request failed.");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    if (!(await run(() => clearCronStorage(projectId, triggerId)))) return;
    returnFocusRef.current = toggleRef;
    setConfirming(false);
    setNoteOpen(false);
  };

  const view = load.status === "ready" ? load.view : null;
  const empty = view !== null && view.note === "" && view.files.length === 0;
  const noteText = draft ?? view?.note ?? "";
  const dirty = view !== null && draft !== null && draft !== view.note;
  const error = load.status === "error" ? load.message : actionError;
  const hrefFor = (artifactId: string) => cronStorageFileUrl(projectId, triggerId, artifactId);

  return (
    <section className={SECTION_CLASS}>
      <div className="flex min-h-7 items-center justify-between gap-3">
        <div className="flex min-w-0 items-baseline gap-3">
          <h3 className={SECTION_HEADING_CLASS}>Storage</h3>
          {view === null ? (
            load.status === "pending" ? (
              <span aria-label="Loading storage" className={`flex ${SECONDARY_TEXT}`} role="status">
                <Spinner className="h-3 w-3" strokeWidth={1.5} />
              </span>
            ) : null
          ) : (
            <span className={`truncate ${SECONDARY_TEXT}`}>
              {empty
                ? "Empty"
                : `${countText(view.files.length, "file")} · ${formatBytes(view.totalBytes)}`}
            </span>
          )}
        </div>
        {view === null ? null : confirming ? (
          <div className="flex items-center gap-2" key="confirm">
            <span className={ERROR_TEXT} role="alert">
              {confirmText(view)}
            </span>
            <button
              className={SECONDARY_BUTTON_CLASS}
              disabled={busy}
              onClick={() => {
                returnFocusRef.current = trashRef;
                setConfirming(false);
              }}
              ref={cancelRef}
              type="button"
            >
              Cancel
            </button>
            <button
              className={DANGER_BUTTON_CLASS}
              disabled={busy}
              onClick={() => void clear()}
              type="button"
            >
              Delete
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2" key="actions">
            <button
              aria-controls={noteOpen ? noteId : undefined}
              aria-expanded={noteOpen}
              className={`${SECONDARY_BUTTON_CLASS} ${noteOpen ? "border-[var(--color-accent)]! text-[var(--color-text-primary)]" : ""}`}
              onClick={() => setNoteOpen((open) => !open)}
              ref={toggleRef}
              type="button"
            >
              {view.note === "" ? "Add note" : "Note"}
            </button>
            {empty ? null : (
              <button
                aria-label="Clear storage"
                className={TRASH_BUTTON_CLASS}
                disabled={busy}
                onClick={() => {
                  setActionError(null);
                  setConfirming(true);
                }}
                ref={trashRef}
                title="Clear storage"
                type="button"
              >
                <TrashIcon className="h-3 w-3" />
              </button>
            )}
          </div>
        )}
      </div>
      {error ? (
        <span className={`${HARD_WRAP_TEXT_CLASS} ${ERROR_TEXT}`} role="alert">
          {error}
        </span>
      ) : null}
      {view !== null && noteOpen ? (
        <div className="flex flex-col gap-2" id={noteId}>
          <textarea
            aria-label="Storage note"
            className={`${INPUT_CLASS} min-h-22 w-full resize-y`}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Context for later runs..."
            readOnly={busy}
            value={noteText}
          />
          <div className="flex items-center justify-between gap-3">
            {dirty ? (
              <span className="text-[var(--color-status-attention)]">Unsaved changes</span>
            ) : view.note !== "" && view.noteUpdatedAt ? (
              <span className={SECONDARY_TEXT}>
                Updated {formatRelativeTime(view.noteUpdatedAt)}
              </span>
            ) : (
              <span className={SECONDARY_TEXT}>Later runs read this note</span>
            )}
            <button
              className={SECONDARY_BUTTON_CLASS}
              disabled={!dirty || busy}
              onClick={() => void run(() => saveCronStorageNote(projectId, triggerId, noteText))}
              type="button"
            >
              Save
            </button>
          </div>
        </div>
      ) : null}
      {view !== null && view.files.length > 0 ? (
        <div className={FILES_CLASS}>
          <ArtifactList
            artifacts={view.files}
            hrefFor={hrefFor}
            onPreview={(artifactId) => window.open(hrefFor(artifactId), "_blank", "noopener")}
            onSortChange={setSort}
            sort={sort}
          />
        </div>
      ) : null}
    </section>
  );
}
