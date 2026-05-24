import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const tracePath = resolve(repoRoot, "tests/scenario-coverage.json");

const allowedTierJobs = new Map([
  ["web-unit", "quality"],
  ["web-playwright", "playwright"],
  ["v2-fast", "quality"],
  ["v2-runtime", "runtime-integration"],
  ["v2-smoke", "real-agent-smoke"],
  ["onboarding", "onboarding-test"],
]);

interface ScenarioBullet {
  source: string;
  section: string;
  scenario: string;
}

interface ScenarioTrace extends ScenarioBullet {
  tier: string;
  testFiles: string[];
  ciJob: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown parse error";
    throw new Error(
      `Failed to parse ${path}: ${message}`,
      error instanceof Error ? { cause: error } : undefined,
    );
  }
}

function parseTrace(value: unknown): ScenarioTrace[] {
  if (!Array.isArray(value)) {
    throw new Error("Scenario coverage trace must be a JSON array");
  }

  return value.map((entry, index) => {
    if (!isObject(entry)) {
      throw new Error(`Trace entry ${index} must be an object`);
    }
    const { source, section, scenario, tier, testFiles, ciJob } = entry;
    if (
      typeof source !== "string" ||
      typeof section !== "string" ||
      typeof scenario !== "string" ||
      typeof tier !== "string" ||
      typeof ciJob !== "string" ||
      !Array.isArray(testFiles) ||
      testFiles.length === 0 ||
      !testFiles.every((file): file is string => typeof file === "string" && file.length > 0)
    ) {
      throw new Error(`Trace entry ${index} has invalid shape`);
    }
    return { source, section, scenario, tier, testFiles, ciJob };
  });
}

function parseScenarioBullets(source: string, excludedH2: Set<string>): ScenarioBullet[] {
  const text = readFileSync(resolve(repoRoot, source), "utf8");
  let h2 = "";
  let section = "";
  const bullets: ScenarioBullet[] = [];

  for (const line of text.split(/\r?\n/)) {
    const heading = /^(#{2,6})\s+(.+)$/.exec(line);
    if (heading) {
      const hashes = heading[1];
      const title = heading[2];
      if (hashes === undefined || title === undefined) {
        throw new Error(`Invalid heading match in ${source}: ${line}`);
      }
      if (hashes.length === 2) h2 = title;
      section = title;
      continue;
    }

    const bullet = /^-\s+(.+)$/.exec(line);
    if (!bullet || excludedH2.has(h2)) continue;
    const scenario = bullet[1];
    if (scenario === undefined) {
      throw new Error(`Invalid bullet match in ${source}: ${line}`);
    }
    bullets.push({ source, section, scenario });
  }

  return bullets;
}

function traceKey(entry: ScenarioBullet): string {
  return `${entry.source}\n${entry.section}\n${entry.scenario}`;
}

function countByKey(entries: ScenarioBullet[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const key = traceKey(entry);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

describe("scenario coverage trace", () => {
  it("maps every documented business/system scenario to exactly one CI test tier", () => {
    const scenarios = [
      ...parseScenarioBullets("v2/TEST_SCENARIOS.md", new Set(["Tier Rules", "Regression Rule"])),
      ...parseScenarioBullets(
        "packages/web/UI_TEST_SCENARIOS.md",
        new Set(["Voice Input Prerequisites"]),
      ),
    ];
    const traces = parseTrace(readJson(tracePath));

    const scenarioCounts = countByKey(scenarios);
    const traceCounts = countByKey(traces);

    const missing = scenarios.filter((scenario) => !traceCounts.has(traceKey(scenario)));
    const stale = traces.filter((trace) => !scenarioCounts.has(traceKey(trace)));
    const duplicates = [...traceCounts.entries()]
      .filter(([, count]) => count !== 1)
      .map(([key, count]) => `${key} (${count})`);

    expect(missing, "missing trace entries").toEqual([]);
    expect(stale, "stale trace entries").toEqual([]);
    expect(duplicates, "duplicate trace entries").toEqual([]);

    const invalidTierJobs = traces.filter(
      (trace) => allowedTierJobs.get(trace.tier) !== trace.ciJob,
    );
    expect(invalidTierJobs, "invalid tier/job pairs").toEqual([]);

    const missingFiles = traces.flatMap((trace) =>
      trace.testFiles
        .filter((file) => !existsSync(resolve(repoRoot, file)))
        .map((file) => `${trace.source} ${trace.section}: ${file}`),
    );
    expect(missingFiles, "missing test files").toEqual([]);
  });
});
