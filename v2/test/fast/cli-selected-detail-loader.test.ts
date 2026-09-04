import { describe, expect, it, vi } from "vitest";
import { createSelectedDetailLoader } from "../../src/cli.js";
import type { SessionView } from "../../src/types.js";

function detailFixture(overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: "api-1",
    updatedAt: "2026-05-09T00:00:00.000Z",
    ...overrides,
  } as SessionView;
}

function loaderHarness(fetchDetail: (id: string) => Promise<SessionView>) {
  let selectedSessionId: string | null = "api-1";
  let selectedDetail: SessionView | null = null;
  let detailLoading = false;
  let statusMessage: string | undefined;
  const render = vi.fn();
  const loader = createSelectedDetailLoader({
    fetchDetail,
    getSelectedSessionId: () => selectedSessionId,
    setSelectedDetail: (detail) => {
      selectedDetail = detail;
    },
    setDetailLoading: (loading) => {
      detailLoading = loading;
    },
    setStatusMessage: (message) => {
      statusMessage = message;
    },
    render,
  });
  return {
    loader,
    render,
    setSelectedSessionId: (id: string | null) => {
      selectedSessionId = id;
    },
    getSelectedDetail: () => selectedDetail,
    getDetailLoading: () => detailLoading,
    getStatusMessage: () => statusMessage,
  };
}

describe("createSelectedDetailLoader", () => {
  it("never issues a second GET while one is already in flight", async () => {
    let resolveFirst: (() => void) | undefined;
    const fetchDetail = vi.fn(
      () =>
        new Promise<SessionView>((resolve) => {
          resolveFirst = () => resolve(detailFixture());
        }),
    );
    const harness = loaderHarness(fetchDetail);

    const first = harness.loader.load();
    // A refresh tick landing while the selection-change fetch above is
    // still outstanding must be dropped, not stacked as a second GET.
    const second = harness.loader.load();

    expect(fetchDetail).toHaveBeenCalledTimes(1);

    resolveFirst?.();
    await first;
    await second;

    expect(fetchDetail).toHaveBeenCalledTimes(1);
    expect(harness.getSelectedDetail()).toEqual(detailFixture());
  });

  it("issues a fresh GET once the prior one has settled", async () => {
    const fetchDetail = vi.fn().mockResolvedValue(detailFixture());
    const harness = loaderHarness(fetchDetail);

    await harness.loader.load();
    await harness.loader.load();

    expect(fetchDetail).toHaveBeenCalledTimes(2);
  });

  it("clears selectedDetail and stops the loading state on a failed fetch", async () => {
    const fetchDetail = vi.fn().mockRejectedValue(new Error("daemon unreachable"));
    const harness = loaderHarness(fetchDetail);

    await harness.loader.load();

    expect(harness.getSelectedDetail()).toBeNull();
    expect(harness.getDetailLoading()).toBe(false);
    expect(harness.getStatusMessage()).toContain("daemon unreachable");
    expect(harness.render).toHaveBeenCalled();
  });

  it("does not render a stale success once bumpToken invalidates the in-flight fetch", async () => {
    let resolveFirst: ((detail: SessionView) => void) | undefined;
    const fetchDetail = vi.fn(
      () =>
        new Promise<SessionView>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const harness = loaderHarness(fetchDetail);

    const pending = harness.loader.load();
    harness.loader.bumpToken();
    harness.setSelectedSessionId("api-1");

    resolveFirst?.(detailFixture({ id: "api-1" }));
    await pending;

    expect(harness.getSelectedDetail()).toBeNull();
    expect(harness.render).not.toHaveBeenCalled();
  });
});
