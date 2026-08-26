import { ESLint } from "eslint";
import { resolve } from "node:path";

const eslint = new ESLint({ overrideConfigFile: resolve(process.cwd(), "../../eslint.config.js") });

async function lint(source: string, filePath: string) {
  const [result] = await eslint.lintText(source, { filePath });
  return (
    result?.messages.filter((message) => message.ruleId === "spur-web/no-visible-wait-text") ?? []
  );
}

describe("visible wait text lint rule", () => {
  // ESLint resolves the flat config (typescript-eslint's strict ruleset, prettier compat, the
  // custom plugin) lazily on the first lintText call. That resolution is a fixed one-time cost
  // independent of how many tests run; warm it here so it doesn't get attributed to whichever
  // `it` happens to run first and blow past the per-test timeout under load.
  beforeAll(async () => {
    await lint("export function Warm() { return null; }", "packages/web/src/probe.tsx");
  }, 20000);

  it.each([
    "Loading",
    "Loading...",
    "Loading…",
    "Loading preview",
    "Loading account...",
    "Please wait...",
    "Saving…",
    "Starting microphone...",
    "Resolving…",
    "Resolving model...",
  ])("rejects %s in production web source", async (text) => {
    const messages = await lint(
      `export function Probe() { return <p>${text}</p>; }`,
      "packages/web/src/probe.tsx",
    );
    expect(messages).toHaveLength(1);
  });

  it("rejects action template literals", async () => {
    const messages = await lint(
      "export function Probe({ name }) { return <p>{`Loading $" + "{name}...`}</p>; }",
      "packages/web/src/probe.tsx",
    );
    expect(messages).toHaveLength(1);
  });

  it("rejects raw JSX wait text", async () => {
    const messages = await lint(
      "export function Probe() { return <p>Transcribing audio...</p>; }",
      "packages/web/src/probe.tsx",
    );
    expect(messages).toHaveLength(1);
  });

  it("rejects visible placeholders and variable-held wait text", async () => {
    const placeholder = await lint(
      'export function Probe() { return <input placeholder="Please wait..." />; }',
      "packages/web/src/probe.tsx",
    );
    const placeholderVariable = await lint(
      'const status = "Please wait..."; export function Probe() { return <input placeholder={status} />; }',
      "packages/web/src/probe.tsx",
    );
    const variable = await lint(
      'const status = "Loading..."; export function Probe() { return <p>{status}</p>; }',
      "packages/web/src/probe.tsx",
    );
    expect(placeholder).toHaveLength(1);
    expect(placeholderVariable).toHaveLength(1);
    expect(variable).toHaveLength(1);
  });

  it("allows tests, accessibility attributes, connection states, and truncation", async () => {
    const production = await lint(
      'export function Probe() { return <><div aria-label="Loading account..." /><p>Connecting…</p><p>Retrying…</p><p>name...</p></>; }',
      "packages/web/src/probe.tsx",
    );
    const testSource = await lint(
      "export function Probe() { return <p>Loading...</p>; }",
      "packages/web/src/__tests__/probe.test.tsx",
    );
    const mutableVariable = await lint(
      'let status = "Loading..."; status = "Ready"; export function Probe() { return <p>{status}</p>; }',
      "packages/web/src/probe.tsx",
    );
    expect(production).toHaveLength(0);
    expect(testSource).toHaveLength(0);
    expect(mutableVariable).toHaveLength(0);
  });
});
