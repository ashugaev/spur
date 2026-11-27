import { encodeArtifactPath, proxyArtifact } from "@/lib/artifact-proxy";
import { cronStorageDaemonPath } from "@/lib/cron-jobs";

interface RouteContext {
  params: Promise<{ projectId: string; triggerId: string; path: string[] }>;
}

export async function GET(_: Request, context: RouteContext) {
  const { projectId, triggerId, path } = await context.params;
  return proxyArtifact(
    `${cronStorageDaemonPath(projectId, triggerId)}/files/${encodeArtifactPath(path)}`,
  );
}
