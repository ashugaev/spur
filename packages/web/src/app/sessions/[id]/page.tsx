import type { Metadata } from "next";
import { SessionDetail } from "@/components/SessionDetail";
import { decodeRouteParam } from "@/lib/project-routes";

export const dynamic = "force-dynamic";

interface SessionPageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ project?: string }>;
}

export async function generateMetadata({ params }: Pick<SessionPageProps, "params">): Promise<Metadata> {
  const resolvedParams = await params;

  return {
    title: decodeRouteParam(resolvedParams.id),
  };
}

export default async function SessionPage({ params, searchParams }: SessionPageProps) {
  const resolvedParams = await params;
  const resolvedSearchParams = await searchParams;
  const sessionId = decodeRouteParam(resolvedParams.id);
  const projectId = resolvedSearchParams.project?.trim();

  return <SessionDetail projectId={projectId} sessionId={sessionId} />;
}
