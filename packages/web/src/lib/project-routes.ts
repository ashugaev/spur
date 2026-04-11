export function decodeRouteParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

const TERMINAL_QUERY_PARAM = "terminal";

export function buildDashboardPath(projectId?: string | null): string {
  if (!projectId) return "/";
  return `/?project=${encodeURIComponent(projectId)}`;
}

export function buildSessionPath(sessionId: string, projectId?: string | null): string {
  const basePath = `/sessions/${encodeURIComponent(sessionId)}`;
  if (!projectId) return basePath;
  return `${basePath}?project=${encodeURIComponent(projectId)}`;
}

export function getTerminalQuerySessionId(searchParams: URLSearchParams): string | null {
  const value = searchParams.get(TERMINAL_QUERY_PARAM)?.trim();
  return value ? value : null;
}

export function withTerminalQuery(
  search: string,
  terminalSessionId: string | null,
): string {
  const params = new URLSearchParams(search);
  if (terminalSessionId) {
    params.set(TERMINAL_QUERY_PARAM, terminalSessionId);
  } else {
    params.delete(TERMINAL_QUERY_PARAM);
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}
