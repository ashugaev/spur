"use client";

import { useMemo } from "react";
import { formatBytes, formatRelativeTime } from "@/lib/format";
import { isHtmlMimeType } from "@/lib/artifact-html";
import { ArtifactDownloadIcon } from "@/components/icons/ArtifactDownloadIcon";
import { ArtifactOpenExternalIcon } from "@/components/icons/ArtifactOpenExternalIcon";
import { ArtifactPreviewIcon } from "@/components/icons/ArtifactPreviewIcon";
import type { SpurSessionArtifact } from "@/lib/types";

export type ArtifactSortColumn = "name" | "size" | "type" | "updatedAt";
export type ArtifactSortDirection = "asc" | "desc";

export interface ArtifactSortState {
  column: ArtifactSortColumn;
  direction: ArtifactSortDirection;
}

export const DEFAULT_ARTIFACT_SORT: ArtifactSortState = { column: "updatedAt", direction: "desc" };

const COLUMN_DEFAULT_DIRECTION: Record<ArtifactSortColumn, ArtifactSortDirection> = {
  name: "asc",
  size: "desc",
  type: "asc",
  updatedAt: "desc",
};

const COLUMN_HEADERS: ReadonlyArray<{
  column: ArtifactSortColumn;
  label: string;
  className?: string;
}> = [
  { column: "name", label: "Name" },
  { column: "size", label: "Size" },
  { column: "type", label: "Type", className: "hidden sm:table-cell" },
  { column: "updatedAt", label: "Updated" },
];

function compareArtifacts(
  left: SpurSessionArtifact,
  right: SpurSessionArtifact,
  column: ArtifactSortColumn,
): number {
  switch (column) {
    case "name":
      return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
    case "size":
      return left.size - right.size;
    case "type":
      return left.kind.localeCompare(right.kind, undefined, { numeric: true, sensitivity: "base" });
    case "updatedAt":
      // Matches the server comparator (v2/src/session-artifacts.ts) exactly:
      // a bare ISO-string compare, not locale/numeric aware.
      return left.updatedAt.localeCompare(right.updatedAt);
  }
}

// Shared by the list's own render and by the artifact viewer's prev/next
// navigation, so both walk the exact same order.
export function sortArtifacts(
  artifacts: readonly SpurSessionArtifact[],
  sort: ArtifactSortState,
): SpurSessionArtifact[] {
  const sign = sort.direction === "asc" ? 1 : -1;
  return [...artifacts].sort((left, right) => sign * compareArtifacts(left, right, sort.column));
}

function sortIndicator(direction: ArtifactSortDirection): string {
  return direction === "asc" ? "↑" : "↓";
}

const ROW_ACTION_BUTTON_CLASS =
  "inline-flex h-6 w-6 items-center justify-center border border-[var(--color-border-default)] text-[var(--color-text-secondary)] outline-none hover:bg-[var(--color-hover-overlay)] hover:text-[var(--color-text-primary)] focus-visible:border-[var(--color-accent)] focus-visible:text-[var(--color-text-primary)]";

interface ArtifactListProps {
  artifacts: readonly SpurSessionArtifact[];
  hrefFor: (artifactId: string) => string;
  onPreview: (artifactId: string) => void;
  sort: ArtifactSortState;
  onSortChange: (sort: ArtifactSortState) => void;
}

export function ArtifactList({
  artifacts,
  hrefFor,
  onPreview,
  sort,
  onSortChange,
}: ArtifactListProps) {
  const sortedArtifacts = useMemo(() => sortArtifacts(artifacts, sort), [artifacts, sort]);

  const toggleColumn = (column: ArtifactSortColumn) => {
    if (sort.column === column) {
      onSortChange({ column, direction: sort.direction === "asc" ? "desc" : "asc" });
      return;
    }
    onSortChange({ column, direction: COLUMN_DEFAULT_DIRECTION[column] });
  };

  return (
    // Contains any residual overflow to the table itself, never the page:
    // matches the `[&_table]:overflow-x-auto` pattern MarkdownMessage.tsx
    // uses for user-generated tables. `table-fixed` + the colgroup below
    // also let the Name column shrink instead of forcing overflow, so this
    // wrapper is normally just a safety net rather than an active scroller.
    <div className="overflow-x-auto">
      <table className="w-full table-fixed border-collapse">
        <colgroup>
          <col />
          <col className="w-16" />
          <col className="hidden w-16 sm:table-column" />
          <col className="w-20" />
          <col className="w-24" />
        </colgroup>
        <thead>
          <tr className="border-b border-[var(--color-border-default)]">
            {COLUMN_HEADERS.map(({ column, label, className }) => {
              const active = sort.column === column;
              return (
                <th
                  aria-sort={
                    active ? (sort.direction === "asc" ? "ascending" : "descending") : "none"
                  }
                  className={`font-bold text-[var(--color-text-tertiary)] ${className ?? ""}`}
                  key={column}
                  scope="col"
                >
                  <button
                    className="flex w-full items-center gap-1 px-2.5 py-2 text-left uppercase tracking-[0.1em] outline-none hover:text-[var(--color-text-primary)] focus-visible:text-[var(--color-text-primary)]"
                    onClick={() => toggleColumn(column)}
                    type="button"
                  >
                    {label}
                    {active ? (
                      <span aria-hidden="true">{sortIndicator(sort.direction)}</span>
                    ) : null}
                  </button>
                </th>
              );
            })}
            <th
              className="px-2.5 py-2 text-left font-bold uppercase tracking-[0.1em] text-[var(--color-text-tertiary)]"
              scope="col"
            >
              Actions
            </th>
          </tr>
        </thead>
        <tbody>
          {sortedArtifacts.map((artifact) => (
            <tr className="border-b border-[var(--color-border-subtle)]" key={artifact.id}>
              <td className="min-w-0 truncate px-2.5 py-2 font-mono" title={artifact.name}>
                {artifact.name}
              </td>
              <td className="px-2.5 py-2">{formatBytes(artifact.size)}</td>
              <td className="hidden px-2.5 py-2 sm:table-cell">{artifact.kind}</td>
              <td className="px-2.5 py-2">{formatRelativeTime(artifact.updatedAt)}</td>
              <td className="px-2.5 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    aria-label={`Preview ${artifact.name}`}
                    className={ROW_ACTION_BUTTON_CLASS}
                    onClick={() => onPreview(artifact.id)}
                    type="button"
                  >
                    <ArtifactPreviewIcon className="h-3 w-3" />
                  </button>
                  {isHtmlMimeType(artifact.mimeType) ? (
                    <a
                      aria-label={`Open ${artifact.name} in a new tab`}
                      className={ROW_ACTION_BUTTON_CLASS}
                      href={hrefFor(artifact.id)}
                      rel="noreferrer"
                      target="_blank"
                    >
                      <ArtifactOpenExternalIcon className="h-3 w-3" />
                    </a>
                  ) : null}
                  <a
                    aria-label={`Download ${artifact.name}`}
                    className={ROW_ACTION_BUTTON_CLASS}
                    download={artifact.name}
                    href={hrefFor(artifact.id)}
                  >
                    <ArtifactDownloadIcon className="h-3 w-3" />
                  </a>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
