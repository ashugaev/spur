import { cache } from "react";
import { readSpurProjectOptions } from "./spur-projects";

/**
 * Resolve the dashboard display name.
 * Defaults to Spur when no explicit override is provided.
 */
export const getProjectName = cache((): string => {
  const envProject = process.env["SPUR_PROJECT_NAME"]?.trim();
  if (envProject && envProject.length > 0) {
    return envProject;
  }
  return readSpurProjectOptions()[0]?.label ?? "Spur";
});
