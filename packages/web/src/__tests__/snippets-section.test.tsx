import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SnippetsSection } from "@/components/snippets/SnippetsSection";
import { SNIPPET_FETCH_TIMEOUT_MS } from "@/lib/snippets/snippet-protocol";

vi.mock("@/components/snippets/SnippetPanel", () => ({
  SnippetErrorCard: ({ chip }: { chip: string }) => <div>{chip}</div>,
  SnippetPanel: ({ manifest }: { manifest: { revision: number } }) => (
    <div>loaded revision {manifest.revision}</div>
  ),
}));

const SID = "sp-ab12";
const SESSION = { canSend: true, state: "working" as const, queuedMessages: [] };

function files(revision: number) {
  return [
    {
      snippetId: "probe",
      artifact: {
        id: `snippet.${SID}.probe.html`,
        name: `snippet.${SID}.probe.html`,
        size: 200 + revision,
        updatedAt: `2026-11-03T10:00:0${revision}.000Z`,
        createdAt: "2026-11-03T10:00:00.000Z",
        mimeType: "text/html",
        kind: "download" as const,
      },
    },
  ];
}

function html(revision: number): string {
  const manifest = {
    protocolVersion: 1,
    snippetId: "probe",
    ownerSessionId: SID,
    instanceId: "probe-instance",
    revision,
    title: "Probe",
    actions: [
      {
        id: "go",
        label: "Go",
        payload: { type: "object", properties: { note: { type: "string", maxLength: 10 } } },
      },
    ],
  };
  return `<script type="application/spur-snippet+json">${JSON.stringify(manifest)}</script>`;
}

function renderSection(revision: number) {
  return (
    <SnippetsSection sessionId={SID} files={files(revision)} session={SESSION} messages={[]} />
  );
}

describe("SnippetsSection stale loads", () => {
  const restores: Array<() => void> = [];
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    for (const restore of restores.splice(0)) restore();
  });

  // Safari 15.4 to 17.3 lacks AbortSignal.any, and Safari < 16 lacks AbortSignal.timeout.
  function removeSignalStatics() {
    for (const name of ["any", "timeout"] as const) {
      const original = Object.getOwnPropertyDescriptor(AbortSignal, name);
      Object.defineProperty(AbortSignal, name, { value: undefined, configurable: true });
      restores.push(() => {
        if (original) Object.defineProperty(AbortSignal, name, original);
      });
    }
  }

  it("loads without AbortSignal.any or AbortSignal.timeout", async () => {
    removeSignalStatics();
    expect(AbortSignal.any).toBeUndefined();
    expect(AbortSignal.timeout).toBeUndefined();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(html(1))),
    );
    render(renderSection(1));
    await waitFor(() => expect(screen.getByText("loaded revision 1")).toBeInTheDocument());
  });

  it("times out a hung fetch after SNIPPET_FETCH_TIMEOUT_MS", async () => {
    removeSignalStatics();
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      ),
    );
    render(renderSection(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SNIPPET_FETCH_TIMEOUT_MS - 1);
    });
    expect(screen.queryByText("Not loaded")).not.toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(screen.getByText("Not loaded")).toBeInTheDocument();
  });

  it("ignores an older fetch that resolves after a newer valid one", async () => {
    let resolveFirst!: (value: Response) => void;
    let resolveSecond!: (value: Response) => void;
    const signals: AbortSignal[] = [];
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((resolve) => {
            signals.push(init.signal as AbortSignal);
            resolveFirst = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveSecond = resolve;
          }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const view = render(renderSection(1));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    view.rerender(renderSection(2));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(signals[0]?.aborted).toBe(true);

    await act(async () => resolveSecond(new Response(html(2))));
    await waitFor(() => expect(screen.getByText("loaded revision 2")).toBeInTheDocument());
    await act(async () => resolveFirst(new Response("invalid old file")));

    view.rerender(renderSection(2));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Manifest invalid")).not.toBeInTheDocument();
    expect(screen.getByText("loaded revision 2")).toBeInTheDocument();
  });
});
