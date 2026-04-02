export function decodeRouteParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function buildDashboardPath(projectId?: string | null): string {
  if (!projectId) return "/";
  return `/?project=${encodeURIComponent(projectId)}`;
}

export function buildSessionPath(sessionId: string, projectId?: string | null): string {
  const basePath = `/sessions/${encodeURIComponent(sessionId)}`;
  if (!projectId) return basePath;
  return `${basePath}?project=${encodeURIComponent(projectId)}`;
}
