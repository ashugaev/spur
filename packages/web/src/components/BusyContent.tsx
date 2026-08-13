import type { ReactNode } from "react";
import { Spinner } from "@/components/icons/Spinner";

export function BusyContent({
  busy,
  children,
  spinnerClassName = "h-3 w-3",
}: {
  busy: boolean;
  children: ReactNode;
  spinnerClassName?: string;
}) {
  return (
    <span className="inline-grid place-items-center">
      <span
        aria-hidden={busy || undefined}
        className={`col-start-1 row-start-1 inline-flex items-center gap-1.5 ${busy ? "invisible" : ""}`}
      >
        {children}
      </span>
      {busy ? (
        <span className="col-start-1 row-start-1" data-busy-content="true">
          <Spinner className={spinnerClassName} strokeWidth={1.5} />
        </span>
      ) : null}
    </span>
  );
}
