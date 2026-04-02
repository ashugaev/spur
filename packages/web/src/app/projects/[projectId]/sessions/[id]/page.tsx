import { SessionDetail } from "@/components/SessionDetail";
import { decodeRouteParam } from "@/lib/project-routes";

export const dynamic = "force-dynamic";

interface SessionPageProps {
  params: Promise<{ projectId: string; id: string }>;
}

export default async function ProjectSessionPage({ params }: SessionPageProps) {
  const resolved = await params;
  const projectId = decodeRouteParam(resolved.projectId);
  const sessionId = decodeRouteParam(resolved.id);
  return <SessionDetail sessionId={sessionId} projectId={projectId} />;
}

