import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UsageModal } from "@/components/UsageModal";
import type { QuotaSourceResult, UsageReport } from "@/lib/types";

const NOW = Date.parse("2026-11-06T14:00:00.000Z");
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

const okSource: QuotaSourceResult = {
  provider: "claude",
  source: "acc-default",
  label: "default",
  fetchedAt: at(-12_000),
  status: "ok",
  plan: "max",
  windows: [
    { label: "5h", usedPercent: 11, remainingPercent: 89, resetsAt: at(2 * HOUR + 4 * MIN) },
    { label: "weekly", usedPercent: 75, remainingPercent: 25, resetsAt: null },
    { label: "burst", usedPercent: 90, remainingPercent: 10, resetsAt: at(30 * MIN) },
  ],
};

const errorSource: QuotaSourceResult = {
  provider: "codex",
  source: "codex",
  label: "work",
  fetchedAt: at(-2 * MIN),
  status: "error",
  error: "rate_limited",
  message: "usage endpoint <b>rate</b> limited",
  httpStatus: 429,
};

const REPORT: UsageReport = {
  generatedAt: at(-12_000),
  quotas: [okSource, errorSource],
  tokens: [
    {
      window: "today",
      since: "2026-11-06T00:00:00.000Z",
      byProvider: [
        {
          provider: "claude",
          sessionCount: 9,
          totals: {
            inputTokens: 412_000,
            outputTokens: 186_000,
            totalTokens: 20_200_000,
            cacheReadInputTokens: 18_400_000,
          },
          byModel: [
            {
              model: null,
              sessionCount: 1,
              totals: { inputTokens: 23_000, outputTokens: 13_000, totalTokens: 786_000 },
            },
            {
              model: "opus",
              sessionCount: 6,
              totals: { inputTokens: 301_000, outputTokens: 142_000, totalTokens: 15_500_000 },
            },
          ],
        },
      ],
    },
    {
      window: "7d",
      since: "2026-10-30T14:00:00.000Z",
      byProvider: [
        {
          provider: "codex",
          sessionCount: 3,
          totals: { inputTokens: 1_000, outputTokens: 2_000, totalTokens: 3_000 },
          byModel: [
            {
              model: "gpt-seven",
              sessionCount: 3,
              totals: { inputTokens: 1_000, outputTokens: 2_000, totalTokens: 3_000 },
            },
          ],
        },
      ],
    },
    { window: "30d", since: "2026-10-07T14:00:00.000Z", byProvider: [] },
  ],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function stubFetch(...responses: (Response | Promise<Response>)[]) {
  const queue = [...responses];
  const fetchMock = vi.fn(() => {
    const next = queue.shift();
    if (!next) throw new Error("unexpected fetch");
    return Promise.resolve(next);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function renderReady(report: UsageReport = REPORT, onClose = vi.fn()) {
  stubFetch(jsonResponse(report));
  render(<UsageModal onClose={onClose} />);
  await screen.findByText("Quota");
  return onClose;
}

describe("UsageModal load states", () => {
  it("shows a loader while pending", () => {
    stubFetch(new Promise<Response>(() => undefined));
    render(<UsageModal onClose={vi.fn()} />);
    expect(screen.getByRole("status", { name: "Loading usage" })).toBeInTheDocument();
  });

  it("shows the error and Retry refetches through the loader", async () => {
    const second = deferred<Response>();
    const fetchMock = stubFetch(jsonResponse({ error: "x" }, 502), second.promise);
    render(<UsageModal onClose={vi.fn()} />);
    expect(await screen.findByText("Could not load usage")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.getByRole("status", { name: "Loading usage" })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => second.resolve(jsonResponse(REPORT)));
    expect(await screen.findByText("Quota")).toBeInTheDocument();
  });

  it("loads once per open and has no refresh control", async () => {
    const fetchMock = stubFetch(jsonResponse(REPORT));
    render(<UsageModal onClose={vi.fn()} />);
    await screen.findByText("Quota");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: /refresh/i })).not.toBeInTheDocument();
  });

  it("aborts the in-flight request on unmount", () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        signal = init.signal ?? undefined;
        return new Promise<Response>(() => undefined);
      }),
    );
    const { unmount } = render(<UsageModal onClose={vi.fn()} />);
    unmount();
    expect(signal?.aborted).toBe(true);
  });
});

describe("UsageModal closing", () => {
  it("closes on Escape, backdrop click and the esc button", async () => {
    const onClose = await renderReady();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("dialog"));
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Close usage" }));
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("does not close on a click inside the shell", async () => {
    const onClose = await renderReady();
    fireEvent.click(screen.getByRole("heading", { name: "Usage" }));
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("UsageModal quota", () => {
  it("renders header, count, level dot and source heads", async () => {
    await renderReady();
    expect(screen.getByText("updated just now")).toBeInTheDocument();
    expect(screen.getByText("1/2")).toBeInTheDocument();
    expect(screen.getByTestId("quota-dot")).toHaveAttribute("data-level", "attention");
    expect(screen.getAllByText("Claude").length).toBeGreaterThan(0);
    expect(screen.getByText("default", { selector: "span" })).toBeInTheDocument();
    expect(screen.getByText("max")).toHaveClass("uppercase");
    expect(screen.getByText("Codex")).toBeInTheDocument();
    expect(screen.getByText("2m ago")).toBeInTheDocument();
  });

  it("derives the dot level from the sources", async () => {
    await renderReady({ ...REPORT, quotas: [okSource] });
    expect(screen.getByTestId("quota-dot")).toHaveAttribute("data-level", "ready");
  });

  it("marks the dot error when every source failed", async () => {
    await renderReady({ ...REPORT, quotas: [errorSource] });
    expect(screen.getByTestId("quota-dot")).toHaveAttribute("data-level", "error");
  });

  it("shows a neutral dot and empty text when there are no quota sources", async () => {
    await renderReady({ ...REPORT, quotas: [] });
    expect(screen.getByText("No quota sources")).toBeInTheDocument();
    expect(screen.getByText("0/0")).toBeInTheDocument();
    expect(screen.getByTestId("quota-dot")).toHaveAttribute("data-level", "neutral");
  });

  it("omits the plan when null", async () => {
    await renderReady({ ...REPORT, quotas: [{ ...okSource, plan: null }] });
    expect(screen.queryByText("max")).not.toBeInTheDocument();
  });

  it("renders every window with used, left and reset text", async () => {
    await renderReady();
    expect(screen.getByText("11% used")).toBeInTheDocument();
    expect(screen.getByText("89% left")).toBeInTheDocument();
    expect(screen.getByText("resets in 2h 4m")).toBeInTheDocument();
    expect(screen.getByText("no reset time")).toBeInTheDocument();
    expect(screen.getAllByRole("meter")).toHaveLength(3);
    expect(screen.getByRole("meter", { name: "5h" })).toHaveAttribute("aria-valuenow", "11");
  });

  it("tones meters at 75 and 90", async () => {
    await renderReady();
    expect(screen.getByRole("meter", { name: "5h" })).toHaveAttribute("data-tone", "normal");
    expect(screen.getByRole("meter", { name: "weekly" })).toHaveAttribute("data-tone", "attention");
    expect(screen.getByRole("meter", { name: "burst" })).toHaveAttribute("data-tone", "error");
    expect(screen.getByText("75% used")).toHaveClass("text-[var(--color-status-attention)]");
    expect(screen.getByText("90% used")).toHaveClass("text-[var(--color-status-error)]");
    expect(screen.getByText("11% used")).not.toHaveClass("text-[var(--color-status-attention)]");
  });

  it("says no windows reported for an ok source without windows", async () => {
    await renderReady({ ...REPORT, quotas: [{ ...okSource, windows: [] }] });
    expect(screen.getByText("no windows reported")).toBeInTheDocument();
    expect(screen.queryByRole("meter")).not.toBeInTheDocument();
  });

  it("renders error sources with chip, verbatim message and HTTP status, no meter", async () => {
    await renderReady({ ...REPORT, quotas: [errorSource] });
    const chip = screen.getByText("rate limited");
    expect(chip.className).toContain("chip-warn");
    expect(screen.getByText("usage endpoint <b>rate</b> limited")).toBeInTheDocument();
    expect(screen.getByText("HTTP 429")).toBeInTheDocument();
    expect(screen.queryByRole("meter")).not.toBeInTheDocument();
  });

  it("uses error chip tokens and hides HTTP text when status is null", async () => {
    await renderReady({
      ...REPORT,
      quotas: [{ ...errorSource, error: "unauthorized", httpStatus: null }],
    });
    expect(screen.getByText("unauthorized").className).toContain("chip-error");
    expect(screen.queryByText(/HTTP/)).not.toBeInTheDocument();
  });
});

describe("UsageModal tokens", () => {
  it("renders provider and model rows with formatted values", async () => {
    await renderReady();
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(4);
    expect(within(table).getByText("412K")).toBeInTheDocument();
    expect(within(table).getByText("18.4M")).toBeInTheDocument();
    expect(within(table).getByText("opus")).toBeInTheDocument();
    expect(screen.getByText("default", { selector: "td" })).toBeInTheDocument();
  });

  it("renders an em dash for missing optional totals and hides optional columns under sm", async () => {
    await renderReady();
    const table = screen.getByRole("table");
    expect(within(table).getAllByText("—").length).toBeGreaterThan(0);
    for (const name of ["Cache read", "Cache write", "Reasoning"]) {
      expect(screen.getByRole("columnheader", { name })).toHaveClass("hidden", "sm:table-cell");
    }
    expect(screen.getByRole("columnheader", { name: "Total" })).not.toHaveClass("hidden");
  });

  it("switches tabs and shows the since line", async () => {
    await renderReady();
    expect(screen.getByText(/^since Nov 6 /)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "7D" }));
    expect(screen.getByText("gpt-seven")).toBeInTheDocument();
    expect(screen.queryByText("opus")).not.toBeInTheDocument();
    expect(screen.getByText(/^since Oct 30 /)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "7D" })).toHaveAttribute("aria-pressed", "true");
  });

  it("shows the empty-window text", async () => {
    await renderReady();
    fireEvent.click(screen.getByRole("button", { name: "30D" }));
    await waitFor(() => expect(screen.getByText("No sessions in this window")).toBeInTheDocument());
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});
