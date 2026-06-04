import {
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
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return rtlRender(ui, { wrapper: Wrapper, ...options });
}

interface SwitchCallRecord {
  body: unknown;
}

interface MockResponses {
  info?: { status?: number; payload: unknown };
  versions?: { status?: number; payload: unknown };
  switch?: { status?: number; payload: unknown };
  onSwitch?: (record: SwitchCallRecord) => void;
}

function mockFetch(responses: MockResponses) {
  vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (url === "/api/runtime/info") {
      const info = responses.info ?? { payload: { version: "1.0.0" } };
      return new Response(JSON.stringify(info.payload), { status: info.status ?? 200 });
    }
    if (url === "/api/runtime/versions") {
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
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

describe("VersionMenu", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
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
        screen.getByRole("button", { name: "Show Spur version information" }),
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

    const trigger = await screen.findByRole("button", { name: "Show Spur version information" });
    fireEvent.click(trigger);

    await waitFor(() => {
      expect(screen.getAllByText("1.4.2").length).toBeGreaterThanOrEqual(2);
      expect(screen.getByText("1.4.1")).toBeInTheDocument();
      expect(screen.getByText("1.4.0")).toBeInTheDocument();
    });

    expect(screen.getByText("current")).toBeInTheDocument();
  });

  it("shows an update-available badge when a newer release exists", async () => {
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
      expect(screen.getByTestId("version-update-badge")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Show Spur version information" }));

    await waitFor(() => {
      expect(screen.getByText("latest")).toBeInTheDocument();
    });
  });

  it("renders the empty state when no releases are available", async () => {
    mockFetch({
      info: { payload: { version: "1.0.0" } },
      versions: { payload: { current: "1.0.0", available: [] } },
    });

    render(<VersionMenu />);

    const trigger = await screen.findByRole("button", { name: "Show Spur version information" });
    fireEvent.click(trigger);

    await waitFor(() => {
      expect(screen.getByText("No releases available")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("version-update-badge")).not.toBeInTheDocument();
  });

  it("falls back to dev when info request fails", async () => {
    mockFetch({
      info: { status: 502, payload: { error: "daemon offline" } },
      versions: { payload: { current: "", available: [] } },
    });

    render(<VersionMenu />);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Show Spur version information" }),
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
    fireEvent.click(await screen.findByRole("button", { name: "Show Spur version information" }));

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
    fireEvent.click(await screen.findByRole("button", { name: "Show Spur version information" }));
    fireEvent.click(await screen.findByTestId("switch-version-1.5.0"));

    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Switch" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByTestId("version-switch-status")).toHaveTextContent(
        /Restarting Spur on 1\.5\.0/,
      );
    });
    expect(switchCalls).toEqual([{ body: { version: "1.5.0" } }]);
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
    fireEvent.click(await screen.findByRole("button", { name: "Show Spur version information" }));
    fireEvent.click(await screen.findByTestId("switch-version-1.5.0"));
    fireEvent.click(await screen.findByRole("button", { name: "Switch" }));

    await waitFor(() => {
      expect(screen.getByTestId("switch-version-error")).toHaveTextContent(
        /running from a source checkout/,
      );
    });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
