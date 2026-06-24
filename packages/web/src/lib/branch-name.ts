export function normalizeBranchName(input: string): string {
  // Slugify per path component so the result is a valid git ref: collapse
  // illegal-char runs, then clean each "/"-separated component independently
  // (empty components, leading dots, and trailing .lock are all git-illegal).
  return input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9./-]+/g, "-")
    .split("/")
    .map((segment) =>
      segment
        .replace(/-{2,}/g, "-")
        .replace(/\.{2,}/g, ".")
        .replace(/^[-.]+|[-.]+$/g, "")
        .replace(/(\.lock)+$/, "")
        .replace(/[-.]+$/g, ""),
    )
    .filter((segment) => segment.length > 0)
    .join("/");
}
