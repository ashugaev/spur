export interface ProjectTab {
  id: string;
  label: string;
  href: string;
}

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

export function buildProjectSessionPath(projectId: string, sessionId: string): string {
  return `${buildProjectPath(projectId)}/sessions/${encodeURIComponent(sessionId)}`;
}

export function buildSessionPath(sessionId: string, projectId?: string | null): string {
  if (projectId) {
    return buildProjectSessionPath(projectId, sessionId);
  }
  return "/";
}

export function resolveSessionPath(options: {
  sessionId: string;
  projectId?: string | null;
  sessionUrl?: string | null;
}): string {
  const { sessionId, projectId, sessionUrl } = options;

  if (sessionUrl && sessionUrl.startsWith("/projects/")) {
    return sessionUrl;
  }

  if (projectId) {
    return buildProjectSessionPath(projectId, sessionId);
  }

  return "/";
}
