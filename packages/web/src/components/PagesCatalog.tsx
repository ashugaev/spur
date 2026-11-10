"use client";

import { useQuery } from "@tanstack/react-query";
import { BrandGlyph } from "@/components/BrandGlyph";
import { DataRow } from "@/components/DataRow";
import { Zone } from "@/components/Zone";
import { fetchPages, PagesRequestError } from "@/lib/pages-client";
import { buildDashboardPath } from "@/lib/project-routes";

export function PagesCatalog({ projectId }: { projectId?: string }) {
  const pages = useQuery({ queryKey: ["pages"], queryFn: fetchPages, retry: false });
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-[var(--color-border-default)] bg-[var(--color-bg-base)]">
        <div className="mx-auto flex min-h-10 max-w-[1500px] items-center gap-2.5 px-4 py-[7px] sm:px-5 lg:px-6">
          <BrandGlyph />
          <a
            href={buildDashboardPath(projectId)}
            className="inline-flex h-7 items-center gap-1.5 border border-[var(--color-border-default)] px-2 font-bold uppercase text-[var(--color-text-secondary)] transition hover:text-[var(--color-accent)]"
          >
            <svg
              aria-hidden="true"
              className="h-3 w-3"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <path d="m7 3-5 5 5 5M2 8h12" />
            </svg>
            Agents
          </a>
        </div>
      </header>
      <main className="mx-auto w-full max-w-[1500px] px-4 py-4 sm:px-5 lg:px-6">
        <Zone label="Pages" color="var(--color-accent)" count={pages.data?.length ?? 0}>
          {pages.isPending ? (
            <div role="status" aria-label="Loading pages" className="space-y-px">
              {[0, 1, 2].map((key) => (
                <DataRow key={key}>
                  <span className="h-[18px] w-36 animate-pulse bg-[var(--color-bg-elevated)]" />
                </DataRow>
              ))}
            </div>
          ) : pages.isError ? (
            <div
              role="alert"
              className="flex items-center gap-2 px-2 py-2 text-[var(--color-text-secondary)]"
            >
              <svg
                aria-label="Pages request failed"
                role="img"
                className="h-3 w-3 shrink-0 text-[var(--color-status-attention)]"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <path d="M8 1 15 14H1ZM8 5v4M8 11v1" />
              </svg>
              <span>
                Could not load pages
                {pages.error instanceof PagesRequestError ? ` (${pages.error.status})` : ""}.
              </span>
              <button
                type="button"
                onClick={() => void pages.refetch()}
                className="border border-[var(--color-border-default)] px-2 py-1 font-bold uppercase hover:text-[var(--color-accent)]"
              >
                Retry
              </button>
            </div>
          ) : pages.data.length === 0 ? (
            <p className="px-2 py-2 text-[var(--color-text-tertiary)]">No pages yet.</p>
          ) : (
            pages.data.map((page) => (
              <DataRow key={page.id}>
                <a
                  href={page.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={page.title}
                  className="inline-flex min-w-0 max-w-full items-center gap-2 text-[var(--color-text-primary)] hover:text-[var(--color-accent)]"
                >
                  <span className="truncate">{page.title}</span>
                  <svg
                    aria-hidden="true"
                    className="h-3 w-3 shrink-0 text-[var(--color-text-tertiary)]"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  >
                    <path d="M9 2h5v5M14 2 7 9M6 3H2v11h11v-4" />
                  </svg>
                </a>
              </DataRow>
            ))
          )}
        </Zone>
      </main>
    </div>
  );
}
