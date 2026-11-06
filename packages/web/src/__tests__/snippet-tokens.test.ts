import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Static source scan, same idea as visible-wait-lint.test.ts: snippet UI and
// the SDK take every color and shape from --color-* / --spur-* tokens.

const webRoot = resolve(__dirname, "../..");
const componentDir = resolve(webRoot, "src/components/snippets");
const sources = [
  ...readdirSync(componentDir)
    .filter((name) => name.endsWith(".tsx"))
    .map((name) => resolve(componentDir, name)),
  resolve(webRoot, "public/snippets/spur-snippet-sdk.v1.js"),
].map((path) => ({ path, text: readFileSync(path, "utf8") }));

function hits(pattern: RegExp, text: string): string[] {
  return [...text.matchAll(pattern)].map((match) => match[0]);
}

describe("snippet source tokens", () => {
  it("scans the three components and the SDK", () => {
    expect(sources.map((source) => source.path.split("/").pop()).sort()).toEqual([
      "SnippetActionSummary.tsx",
      "SnippetPanel.tsx",
      "SnippetsSection.tsx",
      "spur-snippet-sdk.v1.js",
    ]);
  });

  it.each(sources.map((source) => [source.path.split("/").pop() ?? "", source.text]))(
    "%s has no color literals, radius, dark: variants or theme selectors",
    (_name, text) => {
      expect(hits(/#[0-9a-fA-F]{3,8}\b/g, text)).toEqual([]);
      expect(hits(/\b(?:rgba?|hsla?)\(/g, text)).toEqual([]);
      expect(hits(/\brounded(?!-none\b)(?:-[\w[\]./%-]+)?(?=[\s"'`])/g, text)).toEqual([]);
      expect(hits(/border-radius\s*:\s*(?!0\b)[^;}"]+/g, text)).toEqual([]);
      expect(hits(/\bdark:/g, text)).toEqual([]);
      expect(hits(/data-theme/g, text)).toEqual([]);
    },
  );

  it("the scan itself catches each violation", () => {
    expect(hits(/#[0-9a-fA-F]{3,8}\b/g, "color: #fff")).toHaveLength(1);
    expect(hits(/\b(?:rgba?|hsla?)\(/g, "x rgba(0,0,0,.5)")).toHaveLength(1);
    expect(
      hits(/\brounded(?!-none\b)(?:-[\w[\]./%-]+)?(?=[\s"'`])/g, 'class="rounded-md p-1"'),
    ).toHaveLength(1);
    expect(
      hits(/\brounded(?!-none\b)(?:-[\w[\]./%-]+)?(?=[\s"'`])/g, 'class="rounded p-1"'),
    ).toHaveLength(1);
    expect(
      hits(/\brounded(?!-none\b)(?:-[\w[\]./%-]+)?(?=[\s"'`])/g, 'class="rounded-none p-1"'),
    ).toHaveLength(0);
    expect(hits(/border-radius\s*:\s*(?!0\b)[^;}"]+/g, "border-radius:4px")).toHaveLength(1);
    expect(hits(/border-radius\s*:\s*(?!0\b)[^;}"]+/g, "border-radius:0")).toHaveLength(0);
    expect(hits(/\bdark:/g, "dark:bg-x")).toHaveLength(1);
    expect(hits(/data-theme/g, '[data-theme="light"]')).toHaveLength(1);
  });
});
