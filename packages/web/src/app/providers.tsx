"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { VersionSwitchOverlay } from "@/components/VersionSwitchOverlay";
import { useVersionSwitch, VersionSwitchProvider } from "@/lib/version-switch-context";

// Marks the background app tree `inert` while the blocking overlay is shown,
// so keyboard/pointer interaction can't reach controls behind it (native
// `inert` also removes focus from any element already focused inside). Only
// wraps children in the extra `<div>` while actually blocking — otherwise it
// renders a `Fragment` so the app's DOM structure is unchanged when idle.
function AppContent({ children }: { children: ReactNode }) {
  const { phase } = useVersionSwitch();
  const blocking = phase === "switching" || phase === "failed";
  if (!blocking) return <>{children}</>;
  return <div inert>{children}</div>;
}

export default function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 5_000,
            gcTime: 5 * 60_000,
            refetchOnWindowFocus: false,
            retry: 1,
          },
        },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      <VersionSwitchProvider>
        <AppContent>{children}</AppContent>
        <VersionSwitchOverlay />
      </VersionSwitchProvider>
    </QueryClientProvider>
  );
}
