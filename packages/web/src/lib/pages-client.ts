import { PAGE_ID_RE } from "@/lib/store-proxy";

export interface CatalogPage {
  id: string;
  title: string;
  url: string;
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
  return value.pages.map((entry: unknown) => {
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
      entry.url !== `/p/${entry.id}/`
    ) {
      throw new Error("Invalid pages response");
    }
    return { id: entry.id, title: entry.title, url: `/p/${entry.id}/` };
  });
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
