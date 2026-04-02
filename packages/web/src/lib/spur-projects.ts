import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";

export interface SpurProjectOption {
  id: string;
  name: string;
}

interface SpurConfigShape {
  projects?: Record<string, { name?: string } | null>;
}

function configCandidates(): string[] {
  const envPath = process.env["SPUR_CONFIG_PATH"]?.trim() ?? process.env["SPUR_CONFIG"]?.trim();
  if (envPath) {
    return [resolve(envPath)];
  }
  return [
    resolve(process.cwd(), "spur.yaml"),
    resolve(process.cwd(), "spur.yml"),
    resolve(process.cwd(), "..", "..", "spur.yaml"),
    resolve(process.cwd(), "..", "..", "spur.yml"),
  ];
}

export function readSpurProjectOptions(): SpurProjectOption[] {
  for (const candidate of configCandidates()) {
    if (!existsSync(candidate)) continue;
    const parsed = YAML.parse(readFileSync(candidate, "utf8")) as SpurConfigShape | null;
    return Object.entries(parsed?.projects ?? {}).map(([id, project]) => ({
      id,
      name: project?.name?.trim() || id,
    }));
  }
  return [];
}
