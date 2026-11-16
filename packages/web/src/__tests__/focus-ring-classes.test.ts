import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { compile } from "tailwindcss";
import { describe, expect, it } from "vitest";
import {
  ATTENTION_BUTTON_CLASS,
  CHECKBOX_CLASS,
  DANGER_BUTTON_CLASS,
  PRIMARY_BUTTON_CLASS,
  SECONDARY_BUTTON_CLASS,
} from "@/design/classes";

const SRC = join(__dirname, "..");

// Tailwind v4 `outline-none` and `outline-hidden` both set `--tw-outline-style: none`, and
// `focus-visible:outline-1` only reads that variable, so the ring needs `focus-visible:outline-solid`.
// The classes are compiled with the repo's tailwindcss and the cascade for a focus-visible element
// is replayed from the generated rules.

interface Rule {
  base: Record<string, string>;
  focusVisible: Record<string, string>;
}

function declarations(block: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of block.split(";")) {
    const index = part.indexOf(":");
    if (index > 0) result[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return result;
}

/** Top-level rules of the compiled CSS, split into plain declarations and `&:focus-visible` ones. */
function rulesOf(css: string): Rule[] {
  const rules: Rule[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < css.length; i += 1) {
    if (css[i] === "{") {
      if (depth === 0) start = i + 1;
      depth += 1;
    } else if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        const selector = css.slice(
          css.lastIndexOf("\n", css.lastIndexOf("{", start - 1)) + 1,
          start - 1,
        );
        if (!selector.trim().startsWith(".")) continue;
        const body = css.slice(start, i);
        const focusVisible = [...body.matchAll(/&:focus-visible\s*\{([^{}]*)\}/g)]
          .map((match) => declarations(match[1] ?? ""))
          .reduce((all, next) => ({ ...all, ...next }), {});
        const plain = body.replace(/[&@][^{]*\{(?:[^{}]|\{[^{}]*\})*\}/g, "");
        rules.push({ base: declarations(plain), focusVisible });
      }
    }
  }
  return rules;
}

async function focusedOutline(classes: string): Promise<{ style: string; width: string }> {
  const compiler = await compile("@tailwind utilities;");
  const rules = rulesOf(compiler.build(classes.split(/\s+/).filter(Boolean)));
  // A focus-visible rule is more specific than a plain one, so plain rules apply first.
  const applied: Record<string, string> = {};
  for (const rule of rules) Object.assign(applied, rule.base);
  for (const rule of rules) Object.assign(applied, rule.focusVisible);
  const style = applied["outline-style"] ?? "none";
  return {
    style: style === "var(--tw-outline-style)" ? (applied["--tw-outline-style"] ?? "solid") : style,
    width: applied["outline-width"] ?? "0",
  };
}

describe("keyboard focus ring classes", () => {
  it.each([
    ["secondary", SECONDARY_BUTTON_CLASS],
    ["primary", PRIMARY_BUTTON_CLASS],
    ["danger", DANGER_BUTTON_CLASS],
    ["attention", ATTENTION_BUTTON_CLASS],
    ["checkbox", CHECKBOX_CLASS],
  ])("%s classes draw a solid 1px outline when focus-visible", async (_name, classes) => {
    expect(await focusedOutline(classes)).toEqual({ style: "solid", width: "1px" });
  });

  it("the replay reports no ring when outline-solid is missing", async () => {
    const without = SECONDARY_BUTTON_CLASS.replace("focus-visible:outline-solid", "");
    expect((await focusedOutline(without)).style).toBe("none");
  });

  it("every outline-hidden site also sets focus-visible:outline-solid, and none pairs outline-none with a ring", () => {
    const files = [
      join(SRC, "design", "classes.ts"),
      join(SRC, "components", "TerminalIconButton.tsx"),
      ...readdirSync(join(SRC, "components"))
        .filter((name) => /^(Auth|SwitchAuth)/.test(name))
        .map((name) => join(SRC, "components", name)),
    ];
    const offenders = files.flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .filter(
          (line) =>
            (/\boutline-none\b/.test(line) && /focus-visible:outline\b/.test(line)) ||
            (/\boutline-hidden\b/.test(line) && !/focus-visible:outline-solid\b/.test(line)),
        )
        .map((line) => `${file}: ${line.trim().slice(0, 80)}`),
    );
    expect(offenders).toEqual([]);
  });
});
