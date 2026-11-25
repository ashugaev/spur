import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as recipes from "@/design/classes";
import { BG_BASE_HEX, PAGE_ICON_FG_HEX, TERMINAL_BG_HEX, TERMINAL_THEMES } from "@/design/colors";
import { toneBg, toneBorder, toneColor } from "@/design/tone";

// Design-system guard. Contract and procedure:
// .agents/skills/design-system/references/versioning.md (GUARD).

const srcRoot = resolve(__dirname, "..");
const designDir = resolve(srcRoot, "design");

type TokenEntry = {
  group: string;
  role: string;
  since: string;
  contrast?: number;
  // Defined once from other tokens (color-mix); absent from the light block.
  derived?: true;
  deprecated?: string;
  replacement?: string;
  removeIn?: string;
};
type Registry = {
  version: string;
  surfaces: string[];
  overlays: string[];
  tokens: Record<string, TokenEntry>;
  recipes: Record<string, { since: string }>;
  banned: { pattern: string; use: string }[];
  literalAllow: { file: string; reason: string }[];
};

function isRegistry(value: unknown): value is Registry {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<Registry>;
  return (
    typeof v.version === "string" &&
    Array.isArray(v.surfaces) &&
    Array.isArray(v.overlays) &&
    typeof v.tokens === "object" &&
    typeof v.recipes === "object" &&
    Array.isArray(v.banned) &&
    Array.isArray(v.literalAllow)
  );
}

function loadRegistry(): Registry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(designDir, "registry.json"), "utf8"));
  } catch (error) {
    throw new Error("design/registry.json is not valid JSON", { cause: error });
  }
  if (!isRegistry(parsed)) throw new Error("design/registry.json has the wrong shape");
  return parsed;
}

const registry = loadRegistry();
const tokensCss = readFileSync(join(designDir, "tokens.css"), "utf8");
const lightStart = tokensCss.indexOf(':root[data-theme="light"]');
const darkBlock = tokensCss.slice(tokensCss.indexOf("@theme {"), lightStart);
const lightBlock = tokensCss.slice(lightStart);

function colorTokens(block: string): Map<string, string> {
  return new Map(
    [...block.matchAll(/(--color-[a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]),
  );
}

const dark = colorTokens(darkBlock);
const allDark = new Map(
  [...darkBlock.matchAll(/^\s*(--[a-z0-9-]+):\s*([^;]+);/gm)].map((m) => [
    m[1],
    m[2].replace(/\s+/g, " ").trim(),
  ]),
);
const light = new Map([...dark, ...colorTokens(lightBlock)]);

type Rgba = [number, number, number, number];

function parseColor(value: string): Rgba {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const n = Number.parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const rgba = /^rgba?\(([^)]+)\)$/.exec(value);
  if (rgba) {
    const [r, g, b, a = 1] = rgba[1].split(",").map((part) => Number(part.trim()));
    return [r, g, b, a];
  }
  throw new Error(`unsupported color literal: ${value}`);
}

function over(top: Rgba, under: Rgba): Rgba {
  const a = top[3];
  return [0, 1, 2].map((i) => top[i] * a + under[i] * (1 - a)).concat(1) as Rgba;
}

function luminance([r, g, b]: Rgba): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function ratio(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function semver(version: string): number[] {
  return version.split(".").map(Number);
}

function atLeast(version: string, floor: string): boolean {
  const [a, b] = [semver(version), semver(floor)];
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__tests__" ? [] : sourceFiles(path);
    return /\.(tsx?|css)$/.test(name) ? [path] : [];
  });
}

describe("design system: sync", () => {
  it("light block declares every themed dark --color-* token and nothing else", () => {
    const themed = [...dark.keys()].filter((name) => !registry.tokens[name]?.derived);
    expect([...colorTokens(lightBlock).keys()].sort()).toEqual(themed.sort());
  });

  it("registry lists exactly the tokens declared in the first block", () => {
    expect(Object.keys(registry.tokens).sort()).toEqual([...allDark.keys()].sort());
  });

  it("every registry token states its role", () => {
    const missing = Object.entries(registry.tokens).filter(([, entry]) => !entry.role?.trim());
    expect(missing.map(([name]) => name)).toEqual([]);
  });

  it("every deprecated token aliases its replacement", () => {
    const deprecated = Object.entries(registry.tokens).filter(([, entry]) => entry.deprecated);
    for (const [name, entry] of deprecated) {
      expect(entry.replacement && entry.removeIn).toBeTruthy();
      expect(allDark.get(name)).toBe(`var(${entry.replacement})`);
    }
  });

  it("registry lists exactly the recipes exported by design/classes.ts", () => {
    expect(Object.keys(registry.recipes).sort()).toEqual(Object.keys(recipes).sort());
  });

  it("registry version matches the newest migration file", () => {
    const versions = readdirSync(join(designDir, "migrations"))
      .map((name) => name.replace(/\.md$/, ""))
      .sort((a, b) => (atLeast(a, b) ? (a === b ? 0 : 1) : -1));
    expect(versions.at(-1)).toBe(registry.version);
  });
});

describe("design system: literals and deprecations", () => {
  const allowed = new Set(registry.literalAllow.map((entry) => entry.file));
  const files = sourceFiles(srcRoot).filter((path) => {
    const rel = relative(srcRoot, path);
    return rel !== "design/tokens.css" && rel !== "design/colors.ts" && !allowed.has(rel);
  });
  const literal =
    /#[0-9a-fA-F]{6}\b|\b(?:rgba?|hsla?)\(|\b(?:bg|text|border|ring|fill|stroke|outline|from|to|via)-(?:white|black|zinc|gray|slate|neutral|stone|red|orange|amber|yellow|green|emerald|blue|sky|indigo|violet|purple|pink|rose)\b/g;

  it.each(files.map((path) => [relative(srcRoot, path), path]))(
    "%s has no color literal",
    (_rel, path) => {
      const code = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      expect(code.match(literal) ?? []).toEqual([]);
    },
  );

  it.each(sourceFiles(srcRoot).map((path) => [relative(srcRoot, path), path]))(
    "%s references only registry color tokens",
    (_rel, path) => {
      const used = [...readFileSync(path, "utf8").matchAll(/var\((--color-[a-z0-9-]+)/g)].map(
        (m) => m[1],
      );
      // A name ending in "-" is a template prefix (`--color-status-${tone}`), checked in tone.ts.
      const literal = used.filter((name) => !name.endsWith("-"));
      expect(literal.filter((name) => !(name in registry.tokens))).toEqual([]);
    },
  );

  const scanned = sourceFiles(srcRoot).filter(
    (path) => relative(srcRoot, path) !== "design/tokens.css",
  );
  it.each(
    registry.banned.flatMap((rule) =>
      scanned.map((path) => [relative(srcRoot, path), rule.pattern, rule.use, path] as const),
    ),
  )("%s avoids banned %s (use %s)", (_rel, pattern, _use, path) => {
    const code = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    expect(code.match(new RegExp(pattern, "g")) ?? []).toEqual([]);
  });

  const removed = Object.entries(registry.tokens).filter(
    ([, entry]) => entry.removeIn && atLeast(registry.version, entry.removeIn),
  );
  it.each(removed.map(([name]) => [name]))("%s is gone past its removeIn", (name) => {
    const users = sourceFiles(srcRoot).filter((path) => readFileSync(path, "utf8").includes(name));
    expect(users.map((path) => relative(srcRoot, path))).toEqual([]);
  });
});

describe("design system: contrast", () => {
  const rules = Object.entries(registry.tokens).filter(([, entry]) => entry.contrast);

  it.each(
    (["dark", "light"] as const).flatMap((theme) =>
      rules.map(([name, entry]) => [theme, name, entry.contrast ?? 0] as const),
    ),
  )("%s %s meets %s:1 on every surface and overlay", (theme, name, min) => {
    const values = theme === "dark" ? dark : light;
    const read = (token: string) => {
      const value = values.get(token);
      if (!value) throw new Error(`${token} missing in ${theme}`);
      return parseColor(value);
    };
    const base = read("--color-bg-base");
    const grounds = registry.surfaces.flatMap((surface) => {
      const ground = over(read(surface), base);
      return [ground, ...registry.overlays.map((overlay) => over(read(overlay), ground))];
    });
    const worst = Math.min(...grounds.map((ground) => ratio(over(read(name), ground), ground)));
    expect(worst).toBeGreaterThanOrEqual(min);
  });
});

describe("design system: tone set", () => {
  it.each(["working", "ready", "attention", "error", "inactive"] as const)(
    "%s resolves to registry tokens",
    (tone) => {
      for (const ref of [toneColor(tone), toneBg(tone), toneBorder(tone)]) {
        expect(ref.slice(4, -1) in registry.tokens).toBe(true);
      }
    },
  );
});

describe("design system: colors.ts mirror", () => {
  it.each([
    ["BG_BASE_HEX", BG_BASE_HEX, dark.get("--color-bg-base")],
    ["PAGE_ICON_FG_HEX", PAGE_ICON_FG_HEX, dark.get("--color-text-primary")],
    ["TERMINAL_BG_HEX", TERMINAL_BG_HEX, dark.get("--color-terminal-bg")],
    [
      "TERMINAL_THEMES.light.background",
      TERMINAL_THEMES.light.background,
      light.get("--color-terminal-bg"),
    ],
  ])("%s equals its token", (_name, constant, token) => {
    expect(constant).toBe(token);
  });
});
