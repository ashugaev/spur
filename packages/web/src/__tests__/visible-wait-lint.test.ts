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
  it.each(["Loading...", "Loading…", "Loading preview", "Saving…", "Starting microphone..."])(
    "rejects %s in production web source",
    async (text) => {
      const messages = await lint(
        `export const value = ${JSON.stringify(text)};`,
        "packages/web/src/probe.tsx",
      );
      expect(messages).toHaveLength(1);
    },
  );

  it("rejects action template literals", async () => {
    const messages = await lint(
      "export const value = `Switching Spur to $" + "{target}…`;",
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

  it("allows tests, accessibility labels, connection states, and truncation", async () => {
    const production = await lint(
      'export const values = ["Loading dashboard", "Connecting…", "Retrying…", "name..."];',
      "packages/web/src/probe.tsx",
    );
    const testSource = await lint(
      'export const value = "Loading...";',
      "packages/web/src/__tests__/probe.test.tsx",
    );
    expect(production).toHaveLength(0);
    expect(testSource).toHaveLength(0);
  });
});
