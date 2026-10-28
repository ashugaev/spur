"use client";

import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { BusyContent } from "@/components/BusyContent";
import { Spinner } from "@/components/icons/Spinner";
import { INPUT_CLASS } from "@/design/classes";
import { AGENT_OPTIONS } from "@/lib/agents";
import {
  CronJobEditRequestError,
  fetchCronJobDraft,
  saveCronJobDraft,
  type CronJobEditIdentity,
} from "@/lib/cron-jobs";
import { PROVIDER_REASONING_EFFORTS } from "@/lib/reasoning-effort";
import type { CronJobEditBlock, CronJobEditDraft, CronJobEditUpdate } from "@/lib/types";

type EditorState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      original: CronJobEditDraft;
      values: CronJobEditUpdate;
      error: string | null;
      errorField?: string;
      conflict: boolean;
      saving: boolean;
      saved: boolean;
    };

const BUTTON_CLASS =
  "border border-[var(--color-border-default)] px-2 py-1.5 font-bold uppercase text-[var(--color-text-primary)] outline-none transition hover:border-[var(--color-accent)] focus-visible:border-[var(--color-accent)] disabled:opacity-50";
const LABEL_CLASS = "flex min-w-0 flex-col gap-1.5 text-[var(--color-text-secondary)]";

function editableValues(draft: CronJobEditDraft): CronJobEditUpdate {
  return { revision: draft.revision, schedule: draft.schedule, blocks: draft.blocks };
}

export function CronJobEditor({
  identity,
  onBack,
  onSaved,
  closeRequestRef,
}: {
  identity: CronJobEditIdentity;
  onBack: () => void;
  onSaved: () => void;
  closeRequestRef: MutableRefObject<(() => void) | null>;
}) {
  const [state, setState] = useState<EditorState>({ status: "loading" });
  const loading = state.status === "loading";
  const [reload, setReload] = useState(0);
  const scheduleRef = useRef<HTMLInputElement>(null);
  const feedbackRef = useRef<HTMLDivElement>(null);
  const savingRef = useRef(false);
  const dirty =
    state.status === "ready" &&
    JSON.stringify(state.values) !== JSON.stringify(editableValues(state.original));
  const feedback =
    state.status === "ready"
      ? (state.error ?? (state.saved ? "Saved to YAML. Pending activation." : null))
      : null;

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    fetchCronJobDraft(identity, controller.signal).then(
      (draft) => {
        if (controller.signal.aborted) return;
        setState({
          status: "ready",
          original: draft,
          values: editableValues(draft),
          error: null,
          conflict: false,
          saving: false,
          saved: false,
        });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          status: "error",
          message: error instanceof Error ? error.message : "Could not load disk settings.",
        });
      },
    );
    return () => controller.abort();
  }, [identity, reload]);

  useEffect(() => {
    if (state.status === "ready") scheduleRef.current?.focus();
  }, [state.status]);

  useEffect(() => {
    if (feedback) feedbackRef.current?.focus();
  }, [feedback]);

  const requestBack = () => {
    if (savingRef.current) return;
    if (dirty && !window.confirm("Discard unsaved CronJob changes?")) return;
    onBack();
  };

  useEffect(() => {
    closeRequestRef.current = requestBack;
    return () => {
      closeRequestRef.current = null;
    };
  });

  function change(values: CronJobEditUpdate) {
    setState((current) =>
      current.status === "ready"
        ? {
            ...current,
            values,
            error: current.conflict ? current.error : null,
            errorField: undefined,
            saved: false,
          }
        : current,
    );
  }

  function changeBlock(index: number, patch: Partial<CronJobEditBlock>) {
    if (state.status !== "ready") return;
    change({
      ...state.values,
      blocks: state.values.blocks.map((block, position) =>
        position === index ? { ...block, ...patch } : block,
      ),
    });
  }

  async function save() {
    if (state.status !== "ready" || savingRef.current || state.conflict || !dirty) return;
    savingRef.current = true;
    setState({ ...state, saving: true, error: null, errorField: undefined });
    try {
      const draft = await saveCronJobDraft(identity, state.values);
      setState({
        status: "ready",
        original: draft,
        values: editableValues(draft),
        error: null,
        conflict: false,
        saving: false,
        saved: true,
      });
      onSaved();
    } catch (error) {
      setState((current) =>
        current.status === "ready"
          ? {
              ...current,
              saving: false,
              error: error instanceof Error ? error.message : "Could not save CronJob.",
              conflict: error instanceof CronJobEditRequestError && error.status === 409,
              errorField: error instanceof CronJobEditRequestError ? error.field : undefined,
            }
          : current,
      );
    } finally {
      savingRef.current = false;
    }
  }

  const invalid =
    state.status === "ready" &&
    (!state.values.schedule.trim() ||
      state.values.blocks.some(
        (block) => !block.prompt.trim() || (block.model !== null && block.agent === null),
      ));

  return (
    <>
      <div className="flex shrink-0 items-center gap-3 border-b border-[var(--color-border-default)] px-[13px] py-2">
        <button
          aria-label="Back to cron jobs"
          className={BUTTON_CLASS}
          disabled={state.status === "ready" && state.saving}
          onClick={requestBack}
          type="button"
        >
          ←
        </button>
        <h2
          className="min-w-0 flex-1 truncate font-bold text-[var(--color-text-primary)]"
          id="cron-modal-title"
        >
          <span className="uppercase tracking-[0.1em]">Cron</span> / {identity.triggerId}
        </h2>
        <button
          aria-label="Close cron editor"
          className="uppercase text-[var(--color-text-secondary)] focus-visible:text-[var(--color-accent)]"
          onClick={requestBack}
          type="button"
        >
          esc
        </button>
      </div>
      {loading ? (
        <div
          aria-busy="true"
          aria-label="Loading disk settings"
          className="flex justify-center py-6"
          role="status"
        >
          <Spinner />
        </div>
      ) : state.status === "error" ? (
        <div className="flex flex-col gap-3 p-3 text-[var(--color-status-error)]" role="alert">
          {state.message}
          <button
            className={BUTTON_CLASS}
            onClick={() => setReload((value) => value + 1)}
            type="button"
          >
            Retry
          </button>
        </div>
      ) : (
        <form
          className="flex min-h-0 flex-col gap-4 overflow-y-auto p-3"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <p className="break-all text-[var(--color-text-secondary)]">
            Editing YAML: {state.original.ownerPath}
          </p>
          {feedback ? (
            <div
              className={`flex flex-col gap-2 border p-2 ${state.conflict || state.saved ? "border-[var(--color-status-attention)] text-[var(--color-status-attention)]" : "border-[var(--color-status-error)] text-[var(--color-status-error)]"}`}
              ref={feedbackRef}
              role={state.error ? "alert" : "status"}
              tabIndex={-1}
            >
              <span>{feedback}</span>
              {state.conflict ? (
                <>
                  <span>Your draft is kept. Reload discards it and reads the latest YAML.</span>
                  <button
                    className={BUTTON_CLASS}
                    onClick={() => {
                      if (window.confirm("Discard this draft and reload the latest YAML?"))
                        setReload((value) => value + 1);
                    }}
                    type="button"
                  >
                    Reload YAML
                  </button>
                </>
              ) : null}
            </div>
          ) : null}
          <fieldset className="flex min-w-0 flex-col gap-4" disabled={state.saving}>
            <label className={LABEL_CLASS}>
              <span className="uppercase tracking-[0.1em]">Schedule</span>
              <input
                aria-invalid={state.errorField === "schedule" || undefined}
                className={`${INPUT_CLASS} w-full font-mono`}
                onChange={(event) => change({ ...state.values, schedule: event.target.value })}
                ref={scheduleRef}
                required
                value={state.values.schedule}
              />
            </label>
            <p className="text-[var(--color-text-secondary)]">
              Source {identity.sourceId} · schedule affects:{" "}
              {state.original.sourceTriggerIds.join(", ")}
            </p>
            {state.values.blocks.map((block, index) => (
              <div
                className="flex min-w-0 flex-col gap-3 border-t border-[var(--color-border-subtle)] pt-3"
                key={index}
              >
                <h3 className="uppercase tracking-[0.1em] text-[var(--color-text-secondary)]">
                  Block {index + 1}
                </h3>
                <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-3">
                  <label className={LABEL_CLASS}>
                    <span className="uppercase tracking-[0.1em]">Agent</span>
                    <select
                      aria-label={`Block ${index + 1} agent`}
                      className={`${INPUT_CLASS} w-full`}
                      value={block.agent ?? ""}
                      onChange={(event) =>
                        changeBlock(index, {
                          agent:
                            AGENT_OPTIONS.find((agent) => agent === event.target.value) ?? null,
                        })
                      }
                    >
                      <option value="">Default</option>
                      {AGENT_OPTIONS.map((agent) => (
                        <option key={agent} value={agent}>
                          {agent}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className={LABEL_CLASS}>
                    <span className="uppercase tracking-[0.1em]">Model</span>
                    <input
                      aria-label={`Block ${index + 1} model`}
                      className={`${INPUT_CLASS} w-full`}
                      placeholder="Default"
                      value={block.model ?? ""}
                      onChange={(event) =>
                        changeBlock(index, { model: event.target.value || null })
                      }
                    />
                  </label>
                  <label className={LABEL_CLASS}>
                    <span className="uppercase tracking-[0.1em]">Effort</span>
                    <select
                      aria-label={`Block ${index + 1} effort`}
                      className={`${INPUT_CLASS} w-full`}
                      value={block.reasoningEffort ?? ""}
                      onChange={(event) =>
                        changeBlock(index, {
                          reasoningEffort:
                            PROVIDER_REASONING_EFFORTS.find(
                              (effort) => effort === event.target.value,
                            ) ?? null,
                        })
                      }
                    >
                      <option value="">Default</option>
                      {PROVIDER_REASONING_EFFORTS.map((effort) => (
                        <option key={effort} value={effort}>
                          {effort}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                {block.model !== null && block.agent === null ? (
                  <p className="text-[var(--color-status-error)]">
                    Choose an agent for an explicit model, or clear the model to use Default.
                  </p>
                ) : null}
                <label className={LABEL_CLASS}>
                  <span className="uppercase tracking-[0.1em]">Prompt</span>
                  <textarea
                    aria-label={`Block ${index + 1} prompt`}
                    aria-invalid={state.errorField === `blocks[${index}].prompt` || undefined}
                    className={`${INPUT_CLASS} min-h-28 w-full resize-y font-mono`}
                    onChange={(event) => changeBlock(index, { prompt: event.target.value })}
                    required
                    value={block.prompt}
                  />
                </label>
              </div>
            ))}
          </fieldset>
          <p className="text-[var(--color-text-secondary)]">
            Saves YAML only. Running jobs keep their loaded settings until config is reloaded or the
            daemon restarts.
          </p>
          <div className="flex justify-end gap-2">
            <button
              className={BUTTON_CLASS}
              disabled={state.saving}
              onClick={requestBack}
              type="button"
            >
              Cancel
            </button>
            <button
              aria-busy={state.saving || undefined}
              aria-label={state.saving ? "Saving YAML" : undefined}
              className="bg-[var(--color-accent)] px-2 py-1.5 font-bold uppercase text-[var(--color-text-inverse)] outline-none transition hover:bg-[var(--color-accent-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-60"
              disabled={state.saving || state.conflict || !dirty || invalid}
              type="submit"
            >
              <BusyContent busy={state.saving}>Save YAML</BusyContent>
            </button>
          </div>
        </form>
      )}
    </>
  );
}
