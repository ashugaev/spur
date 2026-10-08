import { createHash } from "node:crypto";
import { object, string, ReviewAppError } from "./github-app.js";

export interface InterfaceSurface {
  kind: "UI" | "CLI" | "config" | "API" | "prompt" | "workflow";
  id: string;
  before: string[];
  after: string[];
  constraints: string[];
}
export interface InterfaceManifest {
  version: 1;
  repository: string;
  baseBranch: string;
  surfaces: InterfaceSurface[];
}
export function clauses(value: unknown): string[] {
  if (!Array.isArray(value)) throw new ReviewAppError("invalid-manifest");
  const result = value.map((entry) => string(entry).trim());
  if (result.some((entry) => !entry)) throw new ReviewAppError("invalid-manifest");
  return [...new Set(result)].sort();
}
export function parseManifest(value: unknown): InterfaceManifest {
  const data = object(value);
  if (data.version !== 1 || !Array.isArray(data.surfaces))
    throw new ReviewAppError("invalid-manifest");
  const surfaces = data.surfaces
    .map((value): InterfaceSurface => {
      const surface = object(value);
      if (!["UI", "CLI", "config", "API", "prompt", "workflow"].includes(String(surface.kind)))
        throw new ReviewAppError("invalid-manifest");
      return {
        kind: surface.kind as InterfaceSurface["kind"],
        id: string(surface.id),
        before: clauses(surface.before),
        after: clauses(surface.after),
        constraints: clauses(surface.constraints),
      };
    })
    .sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
  if (new Set(surfaces.map((surface) => `${surface.kind}:${surface.id}`)).size !== surfaces.length)
    throw new ReviewAppError("duplicate-surface");
  const repository = string(data.repository);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new ReviewAppError("invalid-repository");
  return { version: 1, repository, baseBranch: string(data.baseBranch), surfaces };
}
export function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function manifestDigest(manifest: InterfaceManifest): string {
  return digest(parseManifest(manifest));
}
export function baselineDigest(manifest: InterfaceManifest): string {
  const parsed = parseManifest(manifest);
  return digest({
    ...parsed,
    surfaces: parsed.surfaces.map(({ after: _after, ...surface }) => surface),
  });
}
export interface InterfaceAssessment {
  status: "required" | "N/A" | "unknown";
  manifest: InterfaceManifest;
  dispositions: { path: string; callers: string[]; surfaceIds: string[]; evidence: string[] }[];
}
export function parseAssessment(value: unknown): InterfaceAssessment {
  const data = object(value);
  if (
    !["required", "N/A", "unknown"].includes(String(data.status)) ||
    !Array.isArray(data.dispositions)
  )
    throw new ReviewAppError("invalid-assessment");
  const manifest = parseManifest(data.manifest);
  const dispositions = data.dispositions.map((value) => {
    const row = object(value);
    const result = {
      path: string(row.path),
      callers: clauses(row.callers),
      surfaceIds: clauses(row.surfaceIds),
      evidence: clauses(row.evidence),
    };
    if (
      !result.evidence.length ||
      result.surfaceIds.some((id) => !manifest.surfaces.some((surface) => surface.id === id))
    )
      throw new ReviewAppError("invalid-assessment");
    return result;
  });
  if (new Set(dispositions.map((row) => row.path)).size !== dispositions.length)
    throw new ReviewAppError("invalid-assessment");
  const changed = manifest.surfaces.some(
    (surface) => JSON.stringify(surface.before) !== JSON.stringify(surface.after),
  );
  if ((data.status === "N/A" && changed) || (data.status === "required" && !changed))
    throw new ReviewAppError("invalid-assessment");
  return { status: data.status as InterfaceAssessment["status"], manifest, dispositions };
}
