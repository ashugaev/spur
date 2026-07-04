export const PROMPT_PLACEHOLDER_RE = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g;

export function renderSpawnPrompt(template: string, data: unknown): string {
  return template.replace(PROMPT_PLACEHOLDER_RE, (match, key: string) => {
    if (!data || typeof data !== "object") {
      throw new Error(`Cannot render prompt placeholder ${match}: event data is unavailable`);
    }
    const value = (data as Record<string, unknown>)[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    throw new Error(`Cannot render prompt placeholder ${match}: event data.${key} is unavailable`);
  });
}
