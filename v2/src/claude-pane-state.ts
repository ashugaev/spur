const SELECTED_OPTION_RE = /^\s*❯\s+\d+\.\s+\S/m;

export function claudePaneShowsQuestionChooser(pane: string): boolean {
  const tail = pane.split("\n").slice(-80).join("\n");
  return (
    tail.includes("Enter to select") &&
    tail.includes("Esc to cancel") &&
    tail.includes("Submit") &&
    SELECTED_OPTION_RE.test(tail)
  );
}
