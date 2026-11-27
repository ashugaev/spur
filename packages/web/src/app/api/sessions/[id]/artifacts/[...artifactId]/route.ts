import { encodeArtifactPath, proxyArtifact } from "@/lib/artifact-proxy";

interface RouteContext {
  params: Promise<{ id: string; artifactId: string[] }>;
}

export async function GET(_: Request, context: RouteContext) {
  const { id, artifactId } = await context.params;
  return proxyArtifact(
    `/sessions/${encodeURIComponent(id)}/artifacts/${encodeArtifactPath(artifactId)}`,
  );
}
