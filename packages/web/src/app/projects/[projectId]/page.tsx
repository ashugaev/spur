import { redirect } from "next/navigation";
import { decodeRouteParam } from "@/lib/project-routes";

export const dynamic = "force-dynamic";

interface ProjectDashboardRedirectPageProps {
  params: Promise<{ projectId: string }>;
}

export default async function ProjectDashboardRedirectPage({
  params,
}: ProjectDashboardRedirectPageProps) {
  const resolved = await params;
  const projectId = decodeRouteParam(resolved.projectId).trim();

  if (!projectId) {
    redirect("/");
  }

  const query = new URLSearchParams({ projectId }).toString();
  redirect(`/?${query}`);
}
