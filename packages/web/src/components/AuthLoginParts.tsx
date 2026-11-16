"use client";

import type { ReactNode } from "react";
import { Spinner } from "@/components/icons/Spinner";
import type { AuthLogin } from "@/lib/types";

export type SignInMethod = "oauth" | "device" | "browser" | "api_key";

export function StepLine({ n, children }: { n: number; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <span className="inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center border border-[var(--color-border-strong)] text-[var(--color-text-secondary)]">
        {n}
      </span>
      <span>{children}</span>
    </div>
  );
}

/** `live={false}` inside a parent that is already a live region. */
export function WaitLine({ children, live = true }: { children: ReactNode; live?: boolean }) {
  return (
    <div
      aria-live={live ? "polite" : undefined}
      className="flex items-center gap-2"
      role={live ? "status" : undefined}
    >
      <Spinner className="h-3 w-3 shrink-0 text-[var(--color-status-working)]" strokeWidth={1.5} />
      <span>{children}</span>
    </div>
  );
}

export interface ChecklistItem {
  label: string;
  state: "done" | "active" | "todo";
}

export function Checklist({ items }: { items: ChecklistItem[] }) {
  return (
    <ul
      className="flex flex-col gap-1.5 border border-[var(--color-border-default)] px-3 py-2.5"
      data-testid="auth-login-checklist"
    >
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-2" data-state={item.state}>
          {item.state === "active" ? (
            <Spinner
              className="h-3 w-3 shrink-0 text-[var(--color-status-working)]"
              strokeWidth={1.5}
            />
          ) : (
            <span
              aria-hidden="true"
              className={`w-3 shrink-0 text-center ${item.state === "done" ? "text-[var(--color-status-ready)]" : "text-[var(--color-text-tertiary)]"}`}
            >
              {item.state === "done" ? "✓" : "·"}
            </span>
          )}
          {item.label}
        </li>
      ))}
    </ul>
  );
}

export function ErrorBox({ title, cause }: { title: string; cause: string }) {
  return (
    <div
      className="flex items-start gap-2 border border-[var(--color-chip-error-border)] bg-[var(--color-chip-error-bg)] px-2.5 py-2 text-[var(--color-chip-error-text)]"
      data-testid="auth-login-error"
      role="alert"
    >
      <span
        aria-hidden="true"
        className="mt-1.5 h-1.5 w-1.5 shrink-0 bg-[var(--color-status-error)]"
      />
      <span className="min-w-0 [overflow-wrap:anywhere]">
        {title}
        <span className="mt-0.5 block normal-case tracking-normal text-[var(--color-text-secondary)]">
          {cause}
        </span>
      </span>
    </div>
  );
}

/** Title and cause line for a failed or interrupted sign-in. */
export function loginErrorCopy(
  login: AuthLogin | undefined,
  method: SignInMethod,
  startError: string | null,
): { title: string; cause: string } {
  if (startError) return { title: "Sign-in failed", cause: startError };
  switch (login?.errorCode) {
    case "input_rejected":
      return {
        title: "Sign-in code rejected",
        cause: "The pasted address or code did not match this sign-in. Open the page again.",
      };
    case "expired":
      return method === "device"
        ? { title: "Device code expired", cause: "Not approved within 15 minutes." }
        : { title: "Sign-in expired", cause: "The sign-in page was not completed in time." };
    case "key_rejected":
      return {
        title: "API key rejected",
        cause: "The provider refused the key. Key not saved.",
      };
    case "not_confirmed":
      return {
        title: "Sign-in not confirmed",
        cause: "Credential accepted, but the test request failed. Account stays signed out.",
      };
    case "identity":
      return {
        title: "Account not identified",
        cause: "The signed-in account could not be identified. Account stays signed out.",
      };
    default:
      break;
  }
  if (login?.status === "busy") {
    return {
      title: "Another sign-in is pending",
      cause: "Finish or cancel it, then try again.",
    };
  }
  if (login?.status === "sign-in-required") {
    return { title: "Sign-in cancelled", cause: "Account stays signed out." };
  }
  return { title: "Sign-in failed", cause: login?.error ?? "Account stays signed out." };
}
