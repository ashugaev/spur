export function decodeRouteParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function buildProjectPath(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}`;
}

function buildProjectSessionPath(projectId: string, sessionId: string): string {
  return `${buildProjectPath(projectId)}/sessions/${encodeURIComponent(sessionId)}`;
}

export function buildSessionPath(sessionId: string, projectId?: string | null): string {
  if (projectId) {
    return buildProjectSessionPath(projectId, sessionId);
  }
  return "/";
}
