import { Dashboard } from "@/components/Dashboard";

export const dynamic = "force-dynamic";

type HomeProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function firstSearchValue(value: string | string[] | undefined): string {
  const firstValue = Array.isArray(value) ? value[0] : value;
  return firstValue?.trim() ?? "";
}

function buildInitialLocationSearch(searchParams: Record<string, string | string[] | undefined>) {
  const params = new URLSearchParams();
  const project = firstSearchValue(searchParams.project);
  const terminal = firstSearchValue(searchParams.terminal);

  if (project) params.set("project", project);
  if (terminal) params.set("terminal", terminal);

  const query = params.toString();
  return query ? `?${query}` : "";
}

export default async function Home({ searchParams }: HomeProps) {
  const resolvedSearchParams = await searchParams;
  return <Dashboard initialLocationSearch={buildInitialLocationSearch(resolvedSearchParams)} />;
}
