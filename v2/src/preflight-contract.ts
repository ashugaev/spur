export const PREFLIGHT_DEFER_SENTINEL = "NO_PROJECT_RULES";

export const DEFAULT_PROJECT_PREFLIGHT_PROMPT = `Return only a git branch name that follows the project's branch-naming rules and uses identifiers from the user's task prompt when they fit those rules. Return ${PREFLIGHT_DEFER_SENTINEL} if the project defines no branch-naming rules, or if it does but the task provides no identifiers to satisfy them.`;
