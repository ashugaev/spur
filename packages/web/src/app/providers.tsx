"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { BackendConnectionOverlay } from "@/components/BackendConnectionOverlay";
import { VersionSwitchOverlay } from "@/components/VersionSwitchOverlay";
import { BackendConnectionProvider, useBackendConnection } from "@/lib/backend-connection-context";
import { ThemeProvider } from "@/lib/theme-context";
import { useVersionSwitch, VersionSwitchProvider } from "@/lib/version-switch-context";

// Marks the background app tree `inert` while a blocking overlay is shown,
// so keyboard/pointer interaction can't reach controls behind it (native
// `inert` also removes focus from any element already focused inside). Keep
// one wrapper across both states so opening the overlay never remounts the
// app tree and discards local state. `contents` removes its idle layout box.
function AppContent({ children }: { children: ReactNode }) {
  const { phase: versionSwitchPhase } = useVersionSwitch();
  const { phase: backendPhase } = useBackendConnection();
  const blocking =
    versionSwitchPhase === "switching" ||
    versionSwitchPhase === "failed" ||
    backendPhase === "disconnected";
  return (
    <div className={blocking ? undefined : "contents"} inert={blocking ? true : undefined}>
      {children}
    </div>
  );
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
    <ThemeProvider>
      <QueryClientProvider client={client}>
        <VersionSwitchProvider>
          <BackendConnectionProvider>
            <AppContent>{children}</AppContent>
            <VersionSwitchOverlay />
            <BackendConnectionOverlay />
          </BackendConnectionProvider>
        </VersionSwitchProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
