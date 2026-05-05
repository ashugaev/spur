interface SubmitHotkeyEvent {
  altKey: boolean;
  ctrlKey: boolean;
  isComposing?: boolean;
  key: string;
  metaKey: boolean;
  shiftKey: boolean;
}

export const PRIMARY_SUBMIT_HINT = "⌘ + ⏎";
export const VOICE_TOGGLE_HINT = "⌘ + .";

function hasPrimaryModifier(event: SubmitHotkeyEvent) {
  return !event.altKey && !event.ctrlKey && !event.isComposing && event.metaKey && !event.shiftKey;
}

function isPrimaryChord(event: SubmitHotkeyEvent, key: string) {
  return event.key === key && hasPrimaryModifier(event);
}

export function isPrimarySubmitHotkey(event: SubmitHotkeyEvent) {
  return isPrimaryChord(event, "Enter");
}

export function isVoiceToggleHotkey(event: SubmitHotkeyEvent) {
  return isPrimaryChord(event, ".");
}
