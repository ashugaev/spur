export function normalizeBranchName(input: string): string {
  let value = input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9./-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^[-./]+|[-./]+$/g, "");
  value = value.replace(/(\.lock)+$/, "").replace(/^[-./]+|[-./]+$/g, "");
  return value;
}
