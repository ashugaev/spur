"use client";

import { useMemo, useState } from "react";
import { formatBytes, formatRelativeTime } from "@/lib/format";
import { ArtifactDownloadIcon } from "@/components/icons/ArtifactDownloadIcon";
import { ArtifactPreviewIcon } from "@/components/icons/ArtifactPreviewIcon";
import type { SpurSessionArtifact } from "@/lib/types";

type ArtifactSortColumn = "name" | "size" | "type" | "updatedAt";
type ArtifactSortDirection = "asc" | "desc";

interface ArtifactSortState {
  column: ArtifactSortColumn;
  direction: ArtifactSortDirection;
}

const DEFAULT_SORT: ArtifactSortState = { column: "updatedAt", direction: "desc" };

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
  { column: "updatedAt", label: "Updated", className: "hidden md:table-cell" },
];

function compareArtifacts(
  left: SpurSessionArtifact,
  right: SpurSessionArtifact,
  column: ArtifactSortColumn,
): number {
  switch (column) {
    case "name":
      return left.name.localeCompare(right.name);
    case "size":
      return left.size - right.size;
    case "type":
      return left.kind.localeCompare(right.kind);
    case "updatedAt":
      return left.updatedAt.localeCompare(right.updatedAt);
  }
}

function sortIndicator(direction: ArtifactSortDirection): string {
  return direction === "asc" ? "↑" : "↓";
}

interface ArtifactListProps {
  artifacts: readonly SpurSessionArtifact[];
  hrefFor: (artifactId: string) => string;
  onPreview: (artifactId: string) => void;
}

export function ArtifactList({ artifacts, hrefFor, onPreview }: ArtifactListProps) {
  const [sort, setSort] = useState<ArtifactSortState>(DEFAULT_SORT);

  const sortedArtifacts = useMemo(() => {
    const sign = sort.direction === "asc" ? 1 : -1;
    return [...artifacts].sort((left, right) => sign * compareArtifacts(left, right, sort.column));
  }, [artifacts, sort]);

  const toggleColumn = (column: ArtifactSortColumn) => {
    setSort((current) => {
      if (current.column === column) {
        return { column, direction: current.direction === "asc" ? "desc" : "asc" };
      }
      return { column, direction: COLUMN_DEFAULT_DIRECTION[column] };
    });
  };

  return (
    <table className="w-full border-collapse">
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
                  {active ? <span aria-hidden="true">{sortIndicator(sort.direction)}</span> : null}
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
            <td className="max-w-[16rem] truncate px-2.5 py-2 font-mono" title={artifact.name}>
              {artifact.name}
            </td>
            <td className="px-2.5 py-2">{formatBytes(artifact.size)}</td>
            <td className="hidden px-2.5 py-2 sm:table-cell">{artifact.kind}</td>
            <td className="hidden px-2.5 py-2 md:table-cell">
              {formatRelativeTime(artifact.updatedAt)}
            </td>
            <td className="px-2.5 py-2">
              <div className="flex items-center gap-2">
                <button
                  aria-label={`Preview ${artifact.name}`}
                  className="inline-flex h-6 w-6 items-center justify-center border border-[var(--color-border-default)] text-[var(--color-text-secondary)] outline-none hover:bg-[var(--color-hover-overlay)] hover:text-[var(--color-text-primary)] focus-visible:border-[var(--color-accent)] focus-visible:text-[var(--color-text-primary)]"
                  onClick={() => onPreview(artifact.id)}
                  type="button"
                >
                  <ArtifactPreviewIcon className="h-3 w-3" />
                </button>
                <a
                  aria-label={`Download ${artifact.name}`}
                  className="inline-flex h-6 w-6 items-center justify-center border border-[var(--color-border-default)] text-[var(--color-text-secondary)] outline-none hover:bg-[var(--color-hover-overlay)] hover:text-[var(--color-text-primary)] focus-visible:border-[var(--color-accent)] focus-visible:text-[var(--color-text-primary)]"
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
  );
}
