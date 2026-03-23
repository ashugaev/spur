export function shellEscape(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
