"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { VersionSwitchOverlay } from "@/components/VersionSwitchOverlay";
import { VersionSwitchProvider } from "@/lib/version-switch-context";

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
        {children}
        <VersionSwitchOverlay />
      </VersionSwitchProvider>
    </QueryClientProvider>
  );
}
