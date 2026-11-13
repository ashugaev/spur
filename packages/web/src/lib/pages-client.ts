import { PAGE_ID_RE } from "@/lib/store-proxy";

export interface CatalogPage {
  id: string;
  title: string;
  url: string;
  icon?: string;
}

export function parsePage(entry: unknown): CatalogPage {
  if (
    typeof entry !== "object" ||
    entry === null ||
    !("id" in entry) ||
    typeof entry.id !== "string" ||
    !PAGE_ID_RE.test(entry.id) ||
    !("title" in entry) ||
    typeof entry.title !== "string" ||
    !entry.title.trim() ||
    !("url" in entry) ||
    entry.url !== `/p/${entry.id}/` ||
    ("icon" in entry &&
      (typeof entry.icon !== "string" ||
        !/\.png$/i.test(entry.icon) ||
        !entry.icon.split("/").every((segment) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment))))
  )
    throw new Error("Invalid pages response");
  return {
    id: entry.id,
    title: entry.title,
    url: `/p/${entry.id}/`,
    ...("icon" in entry ? { icon: entry.icon as string } : {}),
  };
}

export function parsePages(value: unknown): CatalogPage[] {
  if (
    typeof value !== "object" ||
    value === null ||
    !("pages" in value) ||
    !Array.isArray(value.pages)
  ) {
    throw new Error("Invalid pages response");
  }
  return value.pages.map(parsePage);
}

export class PagesRequestError extends Error {
  constructor(readonly status: number) {
    super(`Pages request failed (${status})`);
  }
}

export async function fetchPages(): Promise<CatalogPage[]> {
  const response = await fetch("/api/pages", { cache: "no-store" });
  if (!response.ok) throw new PagesRequestError(response.status);
  const text = await response.text();
  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    throw new Error("Invalid pages response");
  }
  return parsePages(payload);
}

export async function createPage(): Promise<CatalogPage> {
  const response = await fetch("/api/pages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (!response.ok) throw new PagesRequestError(response.status);
  let payload: unknown;
  try {
    payload = JSON.parse(await response.text()) as unknown;
  } catch {
    throw new Error("Invalid pages response");
  }
  return parsePage(payload);
}
