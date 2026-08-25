import {
  act,
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
  type RenderOptions,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VersionMenu } from "@/components/VersionMenu";
import { VersionSwitchOverlay } from "@/components/VersionSwitchOverlay";
import { VersionSwitchProvider } from "@/lib/version-switch-context";

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, staleTime: 0 },
    },
  });
}

function render(ui: ReactElement, options?: RenderOptions) {
  const client = createTestQueryClient();
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <VersionSwitchProvider>{children}</VersionSwitchProvider>
    </QueryClientProvider>
  );
  return rtlRender(ui, { wrapper: Wrapper, ...options });
}

interface SwitchCallRecord {
  body: unknown;
}

interface MockResponse {
  status?: number;
  payload: unknown;
}

interface AutoUpdateCallRecord {
  body: unknown;
}

interface MockResponses {
  info?: MockResponse | (() => MockResponse);
  versions?: { status?: number; payload: unknown };
  switch?: { status?: number; payload: unknown };
  onSwitch?: (record: SwitchCallRecord) => void;
  autoUpdate?: { status?: number; payload: unknown };
  onAutoUpdate?: (record: AutoUpdateCallRecord) => void;
  onVersionsFetch?: () => void;
  autoUpdateDelay?: Promise<void>;
}

function mockFetch(responses: MockResponses) {
  vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (url === "/api/runtime/info") {
      const info = (typeof responses.info === "function" ? responses.info() : responses.info) ?? {
        payload: { version: "1.0.0" },
      };
      return new Response(JSON.stringify(info.payload), { status: info.status ?? 200 });
    }
    if (url === "/api/runtime/versions") {
      responses.onVersionsFetch?.();
      const versions = responses.versions ?? { payload: { current: "1.0.0", available: [] } };
      return new Response(JSON.stringify(versions.payload), { status: versions.status ?? 200 });
    }
    if (url === "/api/runtime/versions/switch") {
      const rawBody = init?.body;
      let parsedBody: unknown = null;
      if (typeof rawBody === "string") {
        try {
          parsedBody = JSON.parse(rawBody) as unknown;
        } catch {
          parsedBody = null;
        }
      }
      responses.onSwitch?.({ body: parsedBody });
      const switchResponse = responses.switch ?? {
        payload: { accepted: true, version: "1.5.0" },
      };
      return new Response(JSON.stringify(switchResponse.payload), {
        status: switchResponse.status ?? 202,
      });
    }
    if (url === "/api/runtime/auto-update") {
      const rawBody = init?.body;
      let parsedBody: unknown = null;
      if (typeof rawBody === "string") {
        try {
          parsedBody = JSON.parse(rawBody) as unknown;
        } catch {
          parsedBody = null;
        }
      }
      responses.onAutoUpdate?.({ body: parsedBody });
      if (responses.autoUpdateDelay) await responses.autoUpdateDelay;
      const autoUpdateResponse = responses.autoUpdate ?? { payload: { autoUpdate: true } };
      return new Response(JSON.stringify(autoUpdateResponse.payload), {
        status: autoUpdateResponse.status ?? 200,
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

describe("VersionMenu", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.sessionStorage.clear();
    Object.defineProperty(window, "location", {
      value: { ...window.location, reload: vi.fn() },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the running daemon version on the trigger", async () => {
    mockFetch({
      info: { payload: { version: "1.4.2" } },
      versions: { payload: { current: "1.4.2", available: [] } },
    });

    render(<VersionMenu />);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Show Spur version information/ }),
      ).toHaveTextContent("1.4.2");
    });
  });

  it("opens the dropdown with all available versions on click", async () => {
    mockFetch({
      info: { payload: { version: "1.4.2" } },
      versions: {
        payload: {
          current: "1.4.2",
          available: [
            { tag: "1.4.2", publishedAt: "2026-05-30T00:00:00.000Z" },
            { tag: "1.4.1", publishedAt: "2026-05-20T00:00:00.000Z" },
            { tag: "1.4.0", publishedAt: "2026-05-01T00:00:00.000Z" },
          ],
        },
      },
    });

    render(<VersionMenu />);

    const trigger = await screen.findByRole("button", { name: /Show Spur version information/ });
    fireEvent.click(trigger);

    await waitFor(() => {
      expect(screen.getAllByText("1.4.2").length).toBeGreaterThanOrEqual(2);
      expect(screen.getByText("1.4.1")).toBeInTheDocument();
      expect(screen.getByText("1.4.0")).toBeInTheDocument();
    });

    expect(screen.getByText("current")).toBeInTheDocument();
  });

  it("shows the update alert icon when a newer minor release exists", async () => {
    mockFetch({
      info: { payload: { version: "1.4.0" } },
      versions: {
        payload: {
          current: "1.4.0",
          available: [
            { tag: "1.5.0", publishedAt: "2026-06-01T00:00:00.000Z" },
            { tag: "1.4.0", publishedAt: "2026-05-01T00:00:00.000Z" },
          ],
        },
      },
    });

    render(<VersionMenu />);

    await waitFor(() => {
      const icon = screen.getByTestId("version-alert-icon");
      expect(icon).toBeInTheDocument();
      expect(icon).not.toHaveAttribute("data-aggressive");
    });
    expect(screen.getByText("1.4.0")).toHaveAttribute("data-severity", "update");
    expect(
      screen.getByRole("button", { name: /Show Spur version information/ }),
    ).toHaveAccessibleName("Show Spur version information, update available");

    fireEvent.click(screen.getByRole("button", { name: /Show Spur version information/ }));

    await waitFor(() => {
      expect(screen.getByText("latest")).toBeInTheDocument();
    });
  });

  it("escalates to the aggressive alert icon for a major release", async () => {
    mockFetch({
      info: { payload: { version: "1.4.0" } },
      versions: {
        payload: {
          current: "1.4.0",
          available: [
            { tag: "2.0.0", publishedAt: "2026-06-01T00:00:00.000Z" },
            { tag: "1.4.0", publishedAt: "2026-05-01T00:00:00.000Z" },
          ],
        },
      },
    });

    render(<VersionMenu />);

    await waitFor(() => {
      const icon = screen.getByTestId("version-alert-icon");
      expect(icon).toBeInTheDocument();
      expect(icon).toHaveAttribute("data-aggressive", "true");
    });
    expect(screen.getByText("1.4.0")).toHaveAttribute("data-severity", "major");
    expect(
      screen.getByRole("button", { name: /Show Spur version information/ }),
    ).toHaveAccessibleName("Show Spur version information, major update available");
  });

  it("keeps the severity triangle when no update failed", async () => {
    mockFetch({
      info: { payload: { version: "1.4.0" } },
      versions: {
        payload: {
          current: "1.4.0",
          available: [
            { tag: "2.0.0", publishedAt: "2026-06-01T00:00:00.000Z" },
            { tag: "1.4.0", publishedAt: "2026-05-01T00:00:00.000Z" },
          ],
        },
      },
    });

    render(<VersionMenu />);

    await waitFor(() => {
      expect(screen.getByTestId("version-alert-icon")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("version-rollback-icon")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Show Spur version information/ }));
    expect(screen.queryByTestId("version-update-failure")).not.toBeInTheDocument();
  });

  describe("rollback notice", () => {
    const AVAILABLE = [
      { tag: "1.5.0", publishedAt: "2026-06-01T00:00:00.000Z" },
      { tag: "1.4.2", publishedAt: "2026-05-30T00:00:00.000Z" },
    ];

    function mockWithFailure(options: {
      autoUpdate: boolean;
      failureKind: string;
      current?: string;
      available?: Array<{ tag: string; publishedAt: string }>;
    }) {
      const current = options.current ?? "1.4.2";
      mockFetch({
        info: { payload: { version: current } },
        versions: {
          payload: {
            current,
            autoUpdate: options.autoUpdate,
            available: options.available ?? AVAILABLE,
            updateFailure: { version: "1.5.0", failureKind: options.failureKind },
          },
        },
      });
    }

    it("shows the rollback glyph instead of the severity triangle, and the notice above the version row", async () => {
      mockWithFailure({ autoUpdate: false, failureKind: "rolled_back" });

      render(<VersionMenu />);

      const trigger = await screen.findByRole("button", { name: /Show Spur version information/ });
      await waitFor(() => {
        expect(screen.getByTestId("version-rollback-icon")).toBeInTheDocument();
      });
      expect(screen.queryByTestId("version-alert-icon")).not.toBeInTheDocument();
      expect(screen.getByText("1.4.2")).toHaveAttribute("data-severity", "update");

      fireEvent.click(trigger);
      const notice = await screen.findByTestId("version-update-failure");
      expect(notice).toHaveTextContent(
        "Update to 1.5.0 failed, an automatic rollback happened, auto-update is suspended.",
      );
      // Above the current-version row, i.e. the popover's first child.
      expect(notice.parentElement?.firstElementChild).toBe(notice);
      expect(screen.getByRole("checkbox", { name: "Auto update" })).not.toBeChecked();
    });

    it("drops the suspension clause while auto-update is still on", async () => {
      mockWithFailure({ autoUpdate: true, failureKind: "rolled_back" });

      render(<VersionMenu />);

      fireEvent.click(await screen.findByRole("button", { name: /Show Spur version information/ }));
      const notice = await screen.findByTestId("version-update-failure");
      expect(notice).toHaveTextContent("Update to 1.5.0 failed, an automatic rollback happened.");
      expect(notice.textContent).not.toContain("suspended");
      expect(screen.getByRole("checkbox", { name: "Auto update" })).toBeChecked();
    });

    it("says the install was not rolled back for install_unhealthy", async () => {
      mockWithFailure({ autoUpdate: false, failureKind: "install_unhealthy" });

      render(<VersionMenu />);

      fireEvent.click(await screen.findByRole("button", { name: /Show Spur version information/ }));
      expect(await screen.findByTestId("version-update-failure")).toHaveTextContent(
        "Update to 1.5.0 failed and was not rolled back, auto-update is suspended.",
      );
    });

    it("preempts a major severity: one glyph, no aggressive triangle", async () => {
      mockWithFailure({
        autoUpdate: false,
        failureKind: "rolled_back",
        current: "1.4.2",
        available: [
          { tag: "2.0.0", publishedAt: "2026-06-01T00:00:00.000Z" },
          { tag: "1.4.2", publishedAt: "2026-05-30T00:00:00.000Z" },
        ],
      });

      render(<VersionMenu />);

      await waitFor(() => {
        expect(screen.getByTestId("version-rollback-icon")).toBeInTheDocument();
      });
      expect(screen.queryByTestId("version-alert-icon")).not.toBeInTheDocument();
      expect(screen.getByText("1.4.2")).toHaveAttribute("data-severity", "major");
      expect(
        screen.getByRole("button", { name: /Show Spur version information/ }),
      ).toHaveAccessibleName(
        "Show Spur version information, update failed, auto-update is suspended",
      );
    });

    it("renders the glyph and the notice when there is no newer release at all", async () => {
      // The host installed a broken version that was not rolled back, so it is
      // now running the newest release: severity "none", and the old
      // severity-gated markup rendered nothing here.
      mockWithFailure({
        autoUpdate: false,
        failureKind: "install_unhealthy",
        current: "1.5.0",
        available: [{ tag: "1.5.0", publishedAt: "2026-06-01T00:00:00.000Z" }],
      });

      render(<VersionMenu />);

      const trigger = await screen.findByRole("button", { name: /Show Spur version information/ });
      await waitFor(() => {
        expect(screen.getByTestId("version-rollback-icon")).toBeInTheDocument();
      });
      const label = screen.getByText("1.5.0");
      expect(label).toHaveAttribute("data-severity", "none");
      expect(label.className).toContain("font-bold");
      expect(label.className).toContain("--color-status-error");

      fireEvent.click(trigger);
      expect(await screen.findByTestId("version-update-failure")).toBeInTheDocument();
    });

    it("never claims a suspension that is not in effect", async () => {
      mockWithFailure({ autoUpdate: true, failureKind: "install_unhealthy" });

      render(<VersionMenu />);

      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: /Show Spur version information/ }),
        ).toHaveAccessibleName("Show Spur version information, update failed");
      });
    });

    it("rejects a payload whose failureKind is not one of the two kinds", async () => {
      mockWithFailure({ autoUpdate: false, failureKind: "install_failed" });

      render(<VersionMenu />);

      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: /Show Spur version information/ }),
        ).toHaveTextContent("1.4.2");
      });
      expect(screen.queryByTestId("version-rollback-icon")).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: /Show Spur version information/ }));
      expect(screen.queryByTestId("version-update-failure")).not.toBeInTheDocument();
    });

    it("picks up a daemon-side disarm and the notice on the next poll, with no reload", async () => {
      let versionsFetchCount = 0;
      vi.spyOn(global, "fetch").mockImplementation(async (input) => {
        const url = typeof input === "string" ? input : input.url;
        if (url === "/api/runtime/info") {
          return new Response(JSON.stringify({ version: "1.4.2" }), { status: 200 });
        }
        if (url === "/api/runtime/versions") {
          versionsFetchCount += 1;
          const failed = versionsFetchCount > 1;
          return new Response(
            JSON.stringify({
              current: "1.4.2",
              autoUpdate: !failed,
              available: AVAILABLE,
              ...(failed
                ? { updateFailure: { version: "1.5.0", failureKind: "rolled_back" } }
                : {}),
            }),
            { status: 200 },
          );
        }
        throw new Error(`Unexpected fetch: ${url}`);
      });

      vi.useFakeTimers({ shouldAdvanceTime: true });
      render(<VersionMenu />);
      fireEvent.click(await screen.findByRole("button", { name: /Show Spur version information/ }));
      expect(await screen.findByRole("checkbox", { name: "Auto update" })).toBeChecked();
      expect(screen.queryByTestId("version-update-failure")).not.toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });

      await waitFor(() => {
        expect(screen.getByTestId("version-rollback-icon")).toBeInTheDocument();
      });
      expect(screen.getByRole("checkbox", { name: "Auto update" })).not.toBeChecked();
      expect(await screen.findByTestId("version-update-failure")).toBeInTheDocument();
      expect(window.location.reload).not.toHaveBeenCalled();
      expect(versionsFetchCount).toBe(2);
    });

    it("drops the notice the moment Auto is re-enabled, without waiting for a poll", async () => {
      let versionsFetchCount = 0;
      mockFetch({
        info: { payload: { version: "1.4.2" } },
        versions: {
          payload: {
            current: "1.4.2",
            autoUpdate: false,
            available: AVAILABLE,
            updateFailure: { version: "1.5.0", failureKind: "rolled_back" },
          },
        },
        autoUpdate: { payload: { autoUpdate: true } },
        onVersionsFetch: () => {
          versionsFetchCount += 1;
        },
      });

      render(<VersionMenu />);
      fireEvent.click(await screen.findByRole("button", { name: /Show Spur version information/ }));
      await screen.findByTestId("version-update-failure");

      fireEvent.click(screen.getByRole("checkbox", { name: "Auto update" }));

      await waitFor(() => {
        expect(screen.queryByTestId("version-update-failure")).not.toBeInTheDocument();
      });
      expect(screen.queryByTestId("version-rollback-icon")).not.toBeInTheDocument();
      expect(screen.getByRole("checkbox", { name: "Auto update" })).toBeChecked();
      expect(versionsFetchCount).toBe(1);
    });

    it("drops the notice on an accepted switch, which never re-arms auto-update", async () => {
      // No VersionSwitchProvider on purpose: the context default keeps the
      // phase idle, so the popover can be reopened straight after the mutation
      // and the cache write is observable without the 90s poll-exhaustion
      // detour. The blocking overlay is a separate surface, unchanged here.
      const autoUpdateCalls: unknown[] = [];
      let versionsFetchCount = 0;
      mockFetch({
        info: { payload: { version: "1.4.2" } },
        versions: {
          payload: {
            current: "1.4.2",
            autoUpdate: false,
            available: AVAILABLE,
            updateFailure: { version: "1.5.0", failureKind: "rolled_back" },
          },
        },
        switch: { status: 202, payload: { accepted: true, version: "1.5.0", autoUpdate: false } },
        onAutoUpdate: (record) => autoUpdateCalls.push(record.body),
        onVersionsFetch: () => {
          versionsFetchCount += 1;
        },
      });

      const client = new QueryClient({
        defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: 0 } },
      });
      rtlRender(<VersionMenu />, {
        wrapper: ({ children }: { children: ReactNode }) => (
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        ),
      });

      fireEvent.click(await screen.findByRole("button", { name: /Show Spur version information/ }));
      await screen.findByTestId("version-update-failure");
      fireEvent.click(screen.getByTestId("switch-version-1.5.0"));
      fireEvent.click(await screen.findByRole("button", { name: "Switch", exact: true }));

      await waitFor(() => {
        expect(screen.queryByTestId("version-rollback-icon")).not.toBeInTheDocument();
      });
      fireEvent.click(screen.getByRole("button", { name: /Show Spur version information/ }));
      expect(screen.queryByTestId("version-update-failure")).not.toBeInTheDocument();
      expect(screen.getByRole("checkbox", { name: "Auto update" })).not.toBeChecked();
      expect(autoUpdateCalls).toEqual([]);
      expect(versionsFetchCount).toBe(1);
    });
  });

  it("renders the empty state when no releases are available", async () => {
    mockFetch({
      info: { payload: { version: "1.0.0" } },
      versions: { payload: { current: "1.0.0", available: [] } },
    });

    render(<VersionMenu />);

    const trigger = await screen.findByRole("button", { name: /Show Spur version information/ });
    fireEvent.click(trigger);

    await waitFor(() => {
      expect(screen.getByText("No releases available")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("version-alert-icon")).not.toBeInTheDocument();
  });

  it("falls back to dev when info request fails", async () => {
    mockFetch({
      info: { status: 502, payload: { error: "daemon offline" } },
      versions: { payload: { current: "", available: [] } },
    });

    render(<VersionMenu />);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Show Spur version information/ }),
      ).toHaveTextContent("dev");
    });
  });

  it("shows a Switch button only on non-current rows", async () => {
    mockFetch({
      info: { payload: { version: "1.4.2" } },
      versions: {
        payload: {
          current: "1.4.2",
          available: [
            { tag: "1.5.0", publishedAt: "2026-06-01T00:00:00.000Z" },
            { tag: "1.4.2", publishedAt: "2026-05-30T00:00:00.000Z" },
            { tag: "1.4.0", publishedAt: "2026-05-01T00:00:00.000Z" },
          ],
        },
      },
    });

    render(<VersionMenu />);
    fireEvent.click(await screen.findByRole("button", { name: /Show Spur version information/ }));

    await waitFor(() => {
      expect(screen.getByTestId("switch-version-1.5.0")).toBeInTheDocument();
    });
    expect(screen.getByTestId("switch-version-1.4.0")).toBeInTheDocument();
    expect(screen.queryByTestId("switch-version-1.4.2")).not.toBeInTheDocument();
  });

  it("opens the confirm dialog and posts a switch on confirm", async () => {
    const switchCalls: SwitchCallRecord[] = [];
    mockFetch({
      info: { payload: { version: "1.4.2" } },
      versions: {
        payload: {
          current: "1.4.2",
          available: [
            { tag: "1.5.0", publishedAt: "2026-06-01T00:00:00.000Z" },
            { tag: "1.4.2", publishedAt: "2026-05-30T00:00:00.000Z" },
          ],
        },
      },
      switch: { status: 202, payload: { accepted: true, version: "1.5.0" } },
      onSwitch: (record) => switchCalls.push(record),
    });

    render(<VersionMenu />);
    fireEvent.click(await screen.findByRole("button", { name: /Show Spur version information/ }));
    fireEvent.click(await screen.findByTestId("switch-version-1.5.0"));

    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Switch" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(switchCalls).toEqual([{ body: { version: "1.5.0" } }]);
  });

  it("confirms the switch once the daemon reports the target version", async () => {
    let liveVersion = "1.4.2";
    mockFetch({
      info: () => ({ payload: { version: liveVersion } }),
      versions: {
        payload: {
          current: "1.4.2",
          available: [
            { tag: "1.5.0", publishedAt: "2026-06-01T00:00:00.000Z" },
            { tag: "1.4.2", publishedAt: "2026-05-30T00:00:00.000Z" },
          ],
        },
      },
      switch: { status: 202, payload: { accepted: true, version: "1.5.0" } },
    });

    render(<VersionMenu />);
    fireEvent.click(await screen.findByRole("button", { name: /Show Spur version information/ }));
    fireEvent.click(await screen.findByTestId("switch-version-1.5.0"));
    await screen.findByRole("dialog");

    // Fake timers from here so the confirmation poll interval is controllable.
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Switch" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(screen.queryByTestId("switch-version-1.5.0")).not.toBeInTheDocument();

    liveVersion = "1.5.0";
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100);
    });

    expect(window.location.reload).toHaveBeenCalledTimes(1);
  });

  it("reports a failed switch when the daemon never comes back on the target version", async () => {
    mockFetch({
      info: { payload: { version: "1.4.2" } },
      versions: {
        payload: {
          current: "1.4.2",
          available: [
            { tag: "1.5.0", publishedAt: "2026-06-01T00:00:00.000Z" },
            { tag: "1.4.2", publishedAt: "2026-05-30T00:00:00.000Z" },
          ],
        },
      },
      switch: { status: 202, payload: { accepted: true, version: "1.5.0" } },
    });

    render(<VersionMenu />);
    fireEvent.click(await screen.findByRole("button", { name: /Show Spur version information/ }));
    fireEvent.click(await screen.findByTestId("switch-version-1.5.0"));
    await screen.findByRole("dialog");

    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Switch" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000 * 30 + 100);
    });

    expect(window.location.reload).not.toHaveBeenCalled();
  });

  it("renders the registry-unreachable error from a 503 switch response", async () => {
    mockFetch({
      info: { payload: { version: "1.4.2" } },
      versions: {
        payload: {
          current: "1.4.2",
          available: [
            { tag: "1.5.0", publishedAt: "2026-06-01T00:00:00.000Z" },
            { tag: "1.4.2", publishedAt: "2026-05-30T00:00:00.000Z" },
          ],
        },
      },
      switch: { status: 503, payload: { error: "npm registry unreachable" } },
    });

    render(<VersionMenu />);
    fireEvent.click(await screen.findByRole("button", { name: /Show Spur version information/ }));
    fireEvent.click(await screen.findByTestId("switch-version-1.5.0"));
    fireEvent.click(await screen.findByRole("button", { name: "Switch" }));

    await waitFor(() => {
      expect(screen.getByTestId("switch-version-error")).toHaveTextContent(
        /npm registry unreachable/,
      );
    });
  });

  it("renders the source-checkout error from a 409 switch response", async () => {
    mockFetch({
      info: { payload: { version: "1.4.2" } },
      versions: {
        payload: {
          current: "1.4.2",
          available: [
            { tag: "1.5.0", publishedAt: "2026-06-01T00:00:00.000Z" },
            { tag: "1.4.2", publishedAt: "2026-05-30T00:00:00.000Z" },
          ],
        },
      },
      switch: { status: 409, payload: { error: "running from source checkout" } },
    });

    render(<VersionMenu />);
    fireEvent.click(await screen.findByRole("button", { name: /Show Spur version information/ }));
    fireEvent.click(await screen.findByTestId("switch-version-1.5.0"));
    fireEvent.click(await screen.findByRole("button", { name: "Switch" }));

    await waitFor(() => {
      expect(screen.getByTestId("switch-version-error")).toHaveTextContent(
        /running from a source checkout/,
      );
    });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("renders the validated active target from an in-progress 409 response", async () => {
    mockFetch({
      info: { payload: { version: "1.4.2" } },
      versions: {
        payload: {
          current: "1.4.2",
          available: [{ tag: "1.5.0", publishedAt: "2026-06-01T00:00:00.000Z" }],
        },
      },
      switch: {
        status: 409,
        payload: {
          error: "deploy switch already in progress for 1.4.9",
          inProgress: true,
          version: "1.4.9",
        },
      },
    });

    render(<VersionMenu />);
    fireEvent.click(await screen.findByRole("button", { name: /Show Spur version information/ }));
    fireEvent.click(await screen.findByTestId("switch-version-1.5.0"));
    fireEvent.click(await screen.findByRole("button", { name: "Switch" }));

    await waitFor(() => {
      expect(screen.getByTestId("switch-version-error")).toHaveTextContent(
        "Update to 1.4.9 is already in progress.",
      );
    });
  });

  it("renders the Auto checkbox unchecked and dimmed by default", async () => {
    mockFetch({
      info: { payload: { version: "1.4.2" } },
      versions: { payload: { current: "1.4.2", available: [], autoUpdate: false } },
    });

    render(<VersionMenu />);
    fireEvent.click(await screen.findByRole("button", { name: /Show Spur version information/ }));

    const checkbox = await screen.findByRole("checkbox", { name: "Auto update" });
    expect(checkbox).not.toBeChecked();
    expect(screen.getByText("Auto")).toHaveClass("text-[var(--color-text-tertiary)]");
  });

  it("renders the Auto checkbox checked and bold when on", async () => {
    mockFetch({
      info: { payload: { version: "1.4.2" } },
      versions: { payload: { current: "1.4.2", available: [], autoUpdate: true } },
    });

    render(<VersionMenu />);
    fireEvent.click(await screen.findByRole("button", { name: /Show Spur version information/ }));

    const checkbox = await screen.findByRole("checkbox", { name: "Auto update" });
    expect(checkbox).toBeChecked();
    expect(screen.getByText("Auto")).toHaveClass("font-bold");
    expect(screen.getByText("Auto")).toHaveClass("text-[var(--color-text-primary)]");
  });

  it("renders the Auto checkbox unchecked when the field is absent from the payload", async () => {
    mockFetch({
      info: { payload: { version: "1.4.2" } },
      versions: { payload: { current: "1.4.2", available: [] } },
    });

    render(<VersionMenu />);
    fireEvent.click(await screen.findByRole("button", { name: /Show Spur version information/ }));

    const checkbox = await screen.findByRole("checkbox", { name: "Auto update" });
    expect(checkbox).not.toBeChecked();
  });

  it("carries a non-empty tooltip on the Auto label", async () => {
    mockFetch({
      info: { payload: { version: "1.4.2" } },
      versions: { payload: { current: "1.4.2", available: [], autoUpdate: false } },
    });

    render(<VersionMenu />);
    fireEvent.click(await screen.findByRole("button", { name: /Show Spur version information/ }));

    const checkbox = await screen.findByRole("checkbox", { name: "Auto update" });
    const label = checkbox.closest("label");
    expect(label?.getAttribute("title")).toBeTruthy();
  });

  it("toggling posts enabled and settles on the server-confirmed value", async () => {
    const autoUpdateCalls: AutoUpdateCallRecord[] = [];
    mockFetch({
      info: { payload: { version: "1.4.2" } },
      versions: { payload: { current: "1.4.2", available: [], autoUpdate: false } },
      autoUpdate: { payload: { autoUpdate: true } },
      onAutoUpdate: (record) => autoUpdateCalls.push(record),
    });

    render(<VersionMenu />);
    fireEvent.click(await screen.findByRole("button", { name: /Show Spur version information/ }));
    const checkbox = await screen.findByRole("checkbox", { name: "Auto update" });
    fireEvent.click(checkbox);

    await waitFor(() => {
      expect(checkbox).toBeChecked();
    });
    expect(autoUpdateCalls).toEqual([{ body: { enabled: true } }]);
  });

  it("dims the whole Auto control together while the toggle request is in flight", async () => {
    let releaseAutoUpdate: (() => void) | undefined;
    const autoUpdateDelay = new Promise<void>((resolve) => {
      releaseAutoUpdate = resolve;
    });
    mockFetch({
      info: { payload: { version: "1.4.2" } },
      versions: { payload: { current: "1.4.2", available: [], autoUpdate: false } },
      autoUpdate: { payload: { autoUpdate: true } },
      autoUpdateDelay,
    });

    render(<VersionMenu />);
    fireEvent.click(await screen.findByRole("button", { name: /Show Spur version information/ }));
    const checkbox = await screen.findByRole("checkbox", { name: "Auto update" });
    fireEvent.click(checkbox);

    await waitFor(() => {
      expect(checkbox).toBeDisabled();
    });
    const label = checkbox.closest("label");
    expect(label?.className).toContain("cursor-not-allowed");
    expect(label?.className).toContain("opacity-50");
    expect(label?.className).not.toContain("cursor-pointer");

    releaseAutoUpdate?.();
    await waitFor(() => {
      expect(checkbox).not.toBeDisabled();
    });
    expect(label?.className).toContain("cursor-pointer");
    expect(label?.className).not.toContain("opacity-50");
  });

  it("leaves the box at the previous server value on a failed toggle", async () => {
    mockFetch({
      info: { payload: { version: "1.4.2" } },
      versions: { payload: { current: "1.4.2", available: [], autoUpdate: false } },
      autoUpdate: { status: 409, payload: { error: "config changed on disk" } },
    });

    render(<VersionMenu />);
    fireEvent.click(await screen.findByRole("button", { name: /Show Spur version information/ }));
    const checkbox = await screen.findByRole("checkbox", { name: "Auto update" });
    fireEvent.click(checkbox);

    await waitFor(() => {
      expect(checkbox).not.toBeDisabled();
    });
    expect(checkbox).not.toBeChecked();
  });

  it("shows the auto-update disarm sentence in the confirm dialog when Auto is on", async () => {
    mockFetch({
      info: { payload: { version: "1.4.2" } },
      versions: {
        payload: {
          current: "1.4.2",
          autoUpdate: true,
          available: [
            { tag: "1.5.0", publishedAt: "2026-06-01T00:00:00.000Z" },
            { tag: "1.4.2", publishedAt: "2026-05-30T00:00:00.000Z" },
          ],
        },
      },
    });

    render(<VersionMenu />);
    fireEvent.click(await screen.findByRole("button", { name: /Show Spur version information/ }));
    fireEvent.click(await screen.findByTestId("switch-version-1.5.0"));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Auto update will be turned off.");
  });

  it("omits the auto-update disarm sentence when Auto is off", async () => {
    mockFetch({
      info: { payload: { version: "1.4.2" } },
      versions: {
        payload: {
          current: "1.4.2",
          autoUpdate: false,
          available: [
            { tag: "1.5.0", publishedAt: "2026-06-01T00:00:00.000Z" },
            { tag: "1.4.2", publishedAt: "2026-05-30T00:00:00.000Z" },
          ],
        },
      },
    });

    render(<VersionMenu />);
    fireEvent.click(await screen.findByRole("button", { name: /Show Spur version information/ }));
    fireEvent.click(await screen.findByTestId("switch-version-1.5.0"));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).not.toHaveTextContent("Auto update will be turned off.");
  });

  it("reads the box unchecked on the next popover open after the poll-exhaustion failure path", async () => {
    // AC 8: the confirmed (reload) path is the only one that actually
    // refetches — jsdom stubs window.location.reload, so it cannot be
    // observed here. The poll-exhaustion path is the one testable case with
    // no reload: it leaves switchPhase at "failed", dismissed explicitly via
    // the blocking overlay's Dismiss button, at which point the popover can
    // reopen and must read the disarmed value. The 30 x 3s poll outlives the
    // 60s refetch interval, so the daemon answers here as it really does after
    // an accepted switch: already disarmed. The optimistic cache write is
    // covered where it is observable, in "drops the notice on an accepted
    // switch, which never re-arms auto-update".
    let versionsFetchCount = 0;
    mockFetch({
      info: { payload: { version: "1.4.2" } },
      versions: {
        payload: {
          current: "1.4.2",
          autoUpdate: false,
          available: [
            { tag: "1.5.0", publishedAt: "2026-06-01T00:00:00.000Z" },
            { tag: "1.4.2", publishedAt: "2026-05-30T00:00:00.000Z" },
          ],
        },
      },
      switch: { status: 202, payload: { accepted: true, version: "1.5.0", autoUpdate: false } },
      onVersionsFetch: () => {
        versionsFetchCount += 1;
      },
    });

    render(
      <>
        <VersionMenu />
        <VersionSwitchOverlay />
      </>,
    );
    fireEvent.click(await screen.findByRole("button", { name: /Show Spur version information/ }));
    expect(versionsFetchCount).toBe(1);

    fireEvent.click(await screen.findByTestId("switch-version-1.5.0"));
    await screen.findByRole("dialog");

    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Switch" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000 * 30 + 100);
    });
    vi.useRealTimers();

    await screen.findByText("Updating Spur failed");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    fireEvent.click(screen.getByRole("button", { name: /Show Spur version information/ }));
    const checkbox = await screen.findByRole("checkbox", { name: "Auto update" });
    expect(checkbox).not.toBeChecked();
    // One mount fetch plus the 60s poll ticks inside the 90s wait: the footer
    // never unmounts, so this interval is the only thing that keeps the box and
    // the notice honest without a reload.
    expect(versionsFetchCount).toBeGreaterThan(1);
  });
});
