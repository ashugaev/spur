// Agent-authored markup must never run with the dashboard origin: these flags omit
// allow-same-origin, so a framed or standalone artifact gets an opaque origin.
// Mirrors ARTIFACT_HTML_SANDBOX in v2/src/server.ts (no cross-package import) — the
// daemon's server test asserts the two stay token-identical.
export const ARTIFACT_HTML_SANDBOX = "allow-scripts allow-forms allow-popups allow-modals";

export const ARTIFACT_HTML_CSP = `sandbox ${ARTIFACT_HTML_SANDBOX}`;

export function isHtmlMimeType(value: string | null): boolean {
  return value?.split(";")[0].trim().toLowerCase() === "text/html";
}
