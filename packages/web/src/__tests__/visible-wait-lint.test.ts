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
  it.each([
    "Loading",
    "Loading...",
    "Loading…",
    "Loading preview",
    "Loading account...",
    "Please wait...",
    "Saving…",
    "Starting microphone...",
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

  it("allows tests, accessibility attributes, placeholders, connection states, and truncation", async () => {
    const production = await lint(
      'export function Probe() { return <><div aria-label="Loading account..." /><input placeholder="Please wait..." /><p>Connecting…</p><p>Retrying…</p><p>name...</p></>; }',
      "packages/web/src/probe.tsx",
    );
    const testSource = await lint(
      "export function Probe() { return <p>Loading...</p>; }",
      "packages/web/src/__tests__/probe.test.tsx",
    );
    expect(production).toHaveLength(0);
    expect(testSource).toHaveLength(0);
  });
});
