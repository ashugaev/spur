import { PagesCatalog } from "@/components/PagesCatalog";

export const dynamic = "force-dynamic";

export default async function Pages({
  searchParams,
}: {
  searchParams: Promise<{ project?: string | string[] }>;
}) {
  const { project } = await searchParams;
  return <PagesCatalog projectId={typeof project === "string" ? project : undefined} />;
}
