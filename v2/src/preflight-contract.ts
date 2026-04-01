export const PREFLIGHT_DEFER_SENTINEL = "NO_PROJECT_RULES";

export const DEFAULT_PROJECT_PREFLIGHT_PROMPT = `Return only a git branch name that follows the project's branch-naming rules and uses identifiers from the user's task prompt when they fit those rules. If the project does not define branch-naming rules, return ${PREFLIGHT_DEFER_SENTINEL}.`;
