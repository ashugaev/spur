"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { SnippetErrorCard, SnippetPanel } from "@/components/snippets/SnippetPanel";
import { artifactUrl } from "@/components/SessionActionDialogs";
import { formatRelativeTime } from "@/lib/format";
import {
  parseSnippetManifest,
  type OwnedSnippetArtifact,
  type SnippetManifest,
} from "@/lib/snippets/snippet-manifest";
import {
  SNIPPET_FETCH_TIMEOUT_MS,
  SNIPPET_MAX_FILE_BYTES,
  SNIPPET_MAX_MOUNTED,
} from "@/lib/snippets/snippet-protocol";
import type { SnippetSessionUpdate } from "@/lib/snippets/snippet-host";
import type { ConversationMessage } from "@/lib/types";

interface LoadedSnippet {
  manifest: SnippetManifest;
  html: string;
}

type FileProblem =
  | { code: "too_large" }
  | { code: "fetch_failed" }
  | { code: "manifest_invalid"; path: string; message: string }
  | { code: "owner_mismatch" }
  | { code: "lower_revision" };

interface FileEntry {
  key: string;
  loaded: LoadedSnippet | null;
  problem: FileProblem | null;
  fetching: boolean;
}

export interface SnippetsSectionProps {
  sessionId: string;
  files: readonly OwnedSnippetArtifact[];
  session: Omit<SnippetSessionUpdate, "messages" | "fileSettled">;
  messages: readonly ConversationMessage[];
}

const listingKeyOf = ({ artifact }: OwnedSnippetArtifact): string =>
  `${artifact.id}:${artifact.updatedAt}:${artifact.size}`;

// Reads the body stream and aborts once cumulative bytes pass the cap, so a
// file that grew after the listing cannot be buffered whole.
async function readCapped(response: Response, signal: AbortSignal): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    return new TextEncoder().encode(text).length > SNIPPET_MAX_FILE_BYTES ? null : text;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    if (signal.aborted) throw new Error("aborted");
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > SNIPPET_MAX_FILE_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function loadFile(
  sessionId: string,
  file: OwnedSnippetArtifact,
  signal: AbortSignal,
): Promise<{ html: string } | { problem: FileProblem }> {
  if (file.artifact.size > SNIPPET_MAX_FILE_BYTES) return { problem: { code: "too_large" } };
  // Caller abort and timeout share one controller: AbortSignal.any/timeout are missing on Safari < 17.4 / 16.
  const local = new AbortController();
  const abort = () => local.abort();
  if (signal.aborted) abort();
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, SNIPPET_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(artifactUrl(sessionId, file.artifact.id), {
      cache: "no-store",
      signal: local.signal,
    });
    if (!response.ok) return { problem: { code: "fetch_failed" } };
    const html = await readCapped(response, local.signal);
    return html === null ? { problem: { code: "too_large" } } : { html };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

// Settled entry for one fetch result. A rejected file keeps the panel already loaded.
function resolveLoad(
  result: { html: string } | { problem: FileProblem },
  keep: LoadedSnippet | null,
  expected: { sessionId: string; snippetId: string },
): Pick<FileEntry, "loaded" | "problem"> {
  if ("problem" in result) return { loaded: keep, problem: result.problem };
  const parsed = parseSnippetManifest(result.html, expected);
  if (!parsed.ok) return { loaded: keep, problem: parsed.error };
  // A lower revision is refused by the panel's controller (one path), which
  // reports it through onApplyResult.
  return { loaded: { manifest: parsed.manifest, html: result.html }, problem: null };
}

const PROBLEM_CARD: Record<FileProblem["code"], { chip: string; message: string }> = {
  too_large: { chip: "Too large", message: "File over 256 KiB. Not loaded." },
  fetch_failed: { chip: "Not loaded", message: "File could not be fetched." },
  manifest_invalid: { chip: "Manifest invalid", message: "" },
  owner_mismatch: {
    chip: "Wrong owner",
    message: "Snippet belongs to another session. Not mounted.",
  },
  lower_revision: {
    chip: "Older revision",
    message: "Revision is lower than the mounted one. Ignored.",
  },
};

export function SnippetsSection({ sessionId, files, session, messages }: SnippetsSectionProps) {
  const [entries, setEntries] = useState<Record<string, FileEntry>>({});
  // Snippets whose newest file the panel's controller refused as a lower revision.
  const [refused, setRefused] = useState<Record<string, boolean>>({});
  // Title of the file the controller actually mounted, for the refusal card.
  const [mountedTitle, setMountedTitle] = useState<Record<string, string>>({});
  // Listing key each file was last fetched for. A poll that brings a new key
  // starts one fetch; polls with the same key start none.
  const launched = useRef<Record<string, string>>({});
  // Latest fetch per snippet; a superseded one is aborted and its result ignored.
  const inflight = useRef<Record<string, AbortController>>({});
  const unmount = useRef(new AbortController());
  const mounted = useMemo(() => files.slice(0, SNIPPET_MAX_MOUNTED), [files]);
  const excess = files.slice(SNIPPET_MAX_MOUNTED);

  // Declared first so it runs before the fetch effect, also on StrictMode's second mount.
  useEffect(() => {
    const controller = new AbortController();
    unmount.current = controller;
    launched.current = {};
    inflight.current = {};
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = unmount.current;
    for (const file of mounted) {
      const { snippetId } = file;
      const key = listingKeyOf(file);
      if (launched.current[snippetId] === key) continue;
      launched.current[snippetId] = key;
      // A newer listing supersedes the in-flight fetch: abort it so its result is dropped.
      inflight.current[snippetId]?.abort();
      const fetchController = new AbortController();
      inflight.current[snippetId] = fetchController;
      const { signal } = fetchController;
      const abortFetch = () => fetchController.abort();
      controller.signal.addEventListener("abort", abortFetch, { once: true });
      setEntries((previous) => ({
        ...previous,
        [snippetId]: {
          key,
          loaded: previous[snippetId]?.loaded ?? null,
          problem: previous[snippetId]?.problem ?? null,
          fetching: true,
        },
      }));
      const settle = (result: { html: string } | { problem: FileProblem }) => {
        controller.signal.removeEventListener("abort", abortFetch);
        if (signal.aborted) return;
        if ("problem" in result && result.problem.code === "fetch_failed") {
          launched.current[snippetId] = "";
        }
        setEntries((previous) => ({
          ...previous,
          [snippetId]: {
            key,
            ...resolveLoad(result, previous[snippetId]?.loaded ?? null, { sessionId, snippetId }),
            fetching: false,
          },
        }));
      };
      void loadFile(sessionId, file, signal).then(settle, () =>
        settle({ problem: { code: "fetch_failed" } }),
      );
    }
  }, [mounted, sessionId]);

  if (files.length === 0) return null;

  return (
    <section aria-label="Snippets">
      <h2 className="flex items-center gap-2 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--color-text-tertiary)]">
        Snippets
        <div className="flex-1 border-t border-[var(--color-border-subtle)]" />
        <span className="font-normal text-[var(--color-text-secondary)]">{files.length}</span>
      </h2>
      <div className="space-y-3">
        {mounted.map((file) => {
          const { snippetId, artifact } = file;
          const entry = entries[snippetId];
          const titleId = `snippet-card-${sessionId}-${snippetId}`;
          const problem: FileProblem | null =
            entry?.problem ?? (refused[snippetId] ? { code: "lower_revision" } : null);
          const card = problem ? (
            <SnippetErrorCard
              chip={PROBLEM_CARD[problem.code].chip}
              detail={problem.code === "manifest_invalid" ? problem.path || "/" : undefined}
              message={
                problem.code === "manifest_invalid"
                  ? problem.message
                  : PROBLEM_CARD[problem.code].message
              }
              meta={`${snippetId} · ${artifact.size} B`}
              title={
                (problem.code === "lower_revision" ? mountedTitle[snippetId] : undefined) ??
                entry?.loaded?.manifest.title ??
                artifact.name
              }
              titleId={titleId}
            />
          ) : null;
          return (
            <div className="space-y-3" key={snippetId}>
              {card}
              {entry?.loaded ? (
                <SnippetPanel
                  fetching={entry.fetching}
                  html={entry.loaded.html}
                  listingKey={listingKeyOf(file)}
                  manifest={entry.loaded.manifest}
                  messages={messages}
                  onApplyResult={(result) => {
                    const lower = result === "lower_revision";
                    const title = entry.loaded?.manifest.title;
                    // Only a file the controller mounted (or already holds: "ignored" is the
                    // first mount's result) names the mounted title; a conflict or a refusal does not.
                    if ((result === "mounted" || result === "ignored") && title) {
                      setMountedTitle((previous) =>
                        previous[snippetId] === title
                          ? previous
                          : { ...previous, [snippetId]: title },
                      );
                    }
                    setRefused((previous) =>
                      Boolean(previous[snippetId]) === lower
                        ? previous
                        : { ...previous, [snippetId]: lower },
                    );
                  }}
                  session={session}
                  sessionId={sessionId}
                  updatedAt={files.length > 1 ? artifact.updatedAt : undefined}
                />
              ) : null}
            </div>
          );
        })}
        {excess.length > 0 ? (
          <div className="border border-[var(--color-border-subtle)] px-3 py-2">
            <div className="text-[10px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
              Not mounted · limit {SNIPPET_MAX_MOUNTED}
            </div>
            <ul className="mt-1 space-y-0.5">
              {excess.map(({ artifact }) => (
                <li
                  className="text-[var(--color-text-secondary)] [overflow-wrap:anywhere]"
                  key={artifact.id}
                >
                  {artifact.name} · updated {formatRelativeTime(artifact.updatedAt)}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </section>
  );
}
