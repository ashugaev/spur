"use client";

import { INPUT_CLASS } from "@/design/classes";

export function SessionModeSelect({
  value,
  onChange,
  options,
  ariaLabel = "Session mode",
}: {
  value: string;
  onChange: (next: string) => void;
  options: { value: string; label: string }[];
  ariaLabel?: string;
}) {
  return (
    <select
      aria-label={ariaLabel}
      className={INPUT_CLASS}
      onChange={(event) => onChange(event.target.value)}
      value={value}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}
