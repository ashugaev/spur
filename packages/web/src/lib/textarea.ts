export function insertTextAtCursor(
  element: HTMLTextAreaElement | null,
  value: string,
  setValue: (value: string) => void,
) {
  if (!element) {
    setValue(value);
    return;
  }
  const start = element.selectionStart ?? element.value.length;
  const end = element.selectionEnd ?? element.value.length;
  const next = `${element.value.slice(0, start)}${value}${element.value.slice(end)}`;
  setValue(next);
  queueMicrotask(() => {
    element.focus();
    const cursor = start + value.length;
    element.setSelectionRange(cursor, cursor);
  });
}
