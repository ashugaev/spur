export const PREFLIGHT_DEFER_SENTINEL = "NO_PROJECT_RULES";

export const DEFAULT_PROJECT_PREFLIGHT_PROMPT = `Check the repo for relevant skills first, then inspect all agent instruction files for branch-naming rules. Return only a git branch name that follows those rules and uses identifiers from the user's task prompt when they fit. Return ${PREFLIGHT_DEFER_SENTINEL} only if the project defines no branch-naming rules. Do not return prose, markdown, or another value.`;
