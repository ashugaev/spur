// Isolation constants for the snippet iframe, in one place.

// Sandbox is exactly allow-scripts: no same-origin, forms, popups, modals,
// top-navigation. The opaque origin keeps the dashboard cookies and DOM out.
export const SNIPPET_FRAME_SANDBOX = "allow-scripts";

export const SNIPPET_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; form-action 'none'; base-uri 'none'";

// Host prefix first: the CSP meta precedes the boot script, the SDK and every
// byte of agent markup, so the agent can only add stricter policies.
export function buildSnippetSrcdoc(
  agentHtml: string,
  sdkSource: string,
  nonce: string,
  mode: "light" | "dark",
): string {
  const safeSdk = sdkSource.replace(/<\/script/gi, "<\\/script");
  return (
    `<!doctype html><meta charset="utf-8">\n` +
    `<meta http-equiv="Content-Security-Policy" content="${SNIPPET_CSP}">\n` +
    // The host's current mode: without it Chromium paints a light canvas before the SDK connects.
    `<meta name="color-scheme" content="${mode}">\n` +
    `<script>window.__SPUR_SNIPPET_BOOT__={nonce:${JSON.stringify(nonce)}}</script>\n` +
    `<script>${safeSdk}</script>\n` +
    agentHtml
  );
}
