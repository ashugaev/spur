import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ATTENTION_BUTTON_CLASS,
  CHECKBOX_CLASS,
  DANGER_BUTTON_CLASS,
  PRIMARY_BUTTON_CLASS,
  SECONDARY_BUTTON_CLASS,
} from "@/design/classes";

const SRC = join(__dirname, "..");
const RING = [
  "outline-hidden",
  "focus-visible:outline-1",
  "focus-visible:outline-[var(--color-accent)]",
];

// Tailwind v4 `outline-none` sets outline-style: none through a variable, so a later
// `focus-visible:outline` still resolves to none and no ring shows. `outline-hidden` keeps the
// style variable at its solid default.
describe("keyboard focus ring classes", () => {
  it.each([
    ["secondary", SECONDARY_BUTTON_CLASS],
    ["primary", PRIMARY_BUTTON_CLASS],
    ["danger", DANGER_BUTTON_CLASS],
    ["attention", ATTENTION_BUTTON_CLASS],
  ])("%s buttons use outline-hidden with a 1px accent focus-visible outline", (_name, classes) => {
    const tokens = classes.split(/\s+/);
    for (const token of RING) expect(tokens).toContain(token);
    expect(tokens).not.toContain("outline-none");
    expect(tokens).not.toContain("focus-visible:outline");
  });

  it("checkboxes use outline-hidden with an offset accent outline", () => {
    const tokens = CHECKBOX_CLASS.split(/\s+/);
    for (const token of [...RING, "focus-visible:outline-offset-2"])
      expect(tokens).toContain(token);
    expect(tokens).not.toContain("outline-none");
  });

  it("no account surface combines outline-none with a focus-visible outline", () => {
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
        .filter((line) => /\boutline-none\b/.test(line) && /focus-visible:outline\b/.test(line))
        .map((line) => `${file}: ${line.trim().slice(0, 80)}`),
    );
    expect(offenders).toEqual([]);
  });
});
