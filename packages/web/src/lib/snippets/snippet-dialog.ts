// The only module that touches the fullscreen dialog's `open` attribute and
// the focus moves around it. React never renders `open` or autoFocus on the
// dialog: after close() React would not re-add `open`, and its autoFocus calls
// focus() at mount. The host never focuses the snippet iframe.

// Inline panel: declarative `open` attribute, never show() (its focusing steps
// would move focus into the iframe).
export function setInline(dialog: HTMLDialogElement): void {
  dialog.setAttribute("open", "");
}

export function enterFullscreen(
  dialog: HTMLDialogElement,
  iframe: HTMLIFrameElement | null,
  closeButton: HTMLElement | null,
): void {
  // close() restores focus to the element focused at showModal(); never the iframe.
  if (iframe && document.activeElement === iframe) iframe.blur();
  dialog.removeAttribute("open");
  dialog.showModal();
  closeButton?.focus();
}

export function exitFullscreen(dialog: HTMLDialogElement, toggle: HTMLElement | null): void {
  dialog.close();
  dialog.setAttribute("open", "");
  toggle?.focus();
}
