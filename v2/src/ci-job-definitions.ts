import { object, ReviewAppError } from "./github-app.js";

export const REQUIRED_CI_JOB_IDS = [
  "quality",
  "playwright",
  "runtime-integration",
  "real-agent-smoke",
] as const;

export function requiredCiJobNames(definition: unknown): string[] {
  const jobs = object(object(definition).jobs);
  const names = REQUIRED_CI_JOB_IDS.map((id) => {
    const name = object(jobs[id]).name;
    if (typeof name !== "string" || !name.trim())
      throw new ReviewAppError("invalid-required-ci-job");
    return name;
  });
  if (new Set(names).size !== names.length)
    throw new ReviewAppError("duplicate-required-ci-job-name");
  return names;
}
