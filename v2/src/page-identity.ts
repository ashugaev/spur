// Page agent sessions own the `pg-*` session prefixes and `spur-page-*` project ids.
export const RESERVED_PAGE_SESSION_PREFIX = "pg-";
export const RESERVED_PAGE_PROJECT_PREFIX = "spur-page-";

export function assertProjectIdentityNotReserved(projectId: string, sessionPrefix: string): void {
  if (projectId.startsWith(RESERVED_PAGE_PROJECT_PREFIX)) {
    throw new Error(
      `project id "${projectId}" uses the reserved prefix ${RESERVED_PAGE_PROJECT_PREFIX}`,
    );
  }
  if (sessionPrefix.startsWith(RESERVED_PAGE_SESSION_PREFIX)) {
    throw new Error(
      `sessionPrefix "${sessionPrefix}" uses the reserved page prefix ${RESERVED_PAGE_SESSION_PREFIX}`,
    );
  }
}
