import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider, useTheme } from "@/lib/theme-context";
import { ThemeProvider, useTheme } from "@/lib/theme-context";
import { SnippetPanel, type SnippetPanelProps } from "@/components/snippets/SnippetPanel";
import type { SnippetChannel, SnippetPort } from "@/lib/snippets/snippet-host";
import type { SnippetManifest } from "@/lib/snippets/snippet-manifest";
import {
  SNIPPET_CONFIRM_REASON_TEXT,
  type SnippetActionRecord,
  type SnippetActionStatus,
  type SnippetConfirmReason,
  type SnippetTheme,
} from "@/lib/snippets/snippet-protocol";
import {
  budgetKey,
  recordKey,
  type SnippetRecord,
  type SnippetStorage,
} from "@/lib/snippets/snippet-store";

const dialog = vi.hoisted(() => ({
  // jsdom has no show/showModal; the stub keeps the declarative open attribute.
  setInline: vi.fn((node: HTMLElement) => node.setAttribute("open", "")),
  enterFullscreen: vi.fn(),
  exitFullscreen: vi.fn(),
}));
vi.mock("@/lib/snippets/snippet-dialog", () => dialog);

const SID = "sp-ab12";
const NOW = Date.parse("2026-11-03T10:00:00Z");

class MemoryStorage implements SnippetStorage {
  data = new Map<string, string>();
  failAll = false;
  get length(): number {
    return this.data.size;
  }
  key(index: number): string | null {
    return [...this.data.keys()][index] ?? null;
  }
  getItem(key: string): string | null {
    if (this.failAll) throw new Error("denied");
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (this.failAll) throw new Error("denied");
    this.data.set(key, value);
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
}

class FakePort implements SnippetPort {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  toFrame: Array<Record<string, unknown>> = [];
  closed = false;
  postMessage(message: unknown): void {
    this.toFrame.push(message as Record<string, unknown>);
  }
  close(): void {
    this.closed = true;
  }
  emit(data: unknown): void {
    this.onmessage?.({ data });
  }
}

const payloadSchema = {
  type: "object",
  properties: { note: { type: "string", maxLength: 40 } },
} as const;

function manifest(overrides: Partial<SnippetManifest> = {}): SnippetManifest {
  return {
    protocolVersion: 1,
    snippetId: "picker",
    ownerSessionId: SID,
    instanceId: "inst-00000001",
    revision: 1,
    title: "Picker",
    actions: [
      { id: "go", label: "Go", payload: payloadSchema },
      { id: "danger", label: "Danger", payload: payloadSchema, confirm: "always" },
    ],
    ...overrides,
  };
}

interface Setup {
  storage: MemoryStorage;
  ports: FakePort[];
  sent: string[];
  focused: { value: boolean };
  posts: Array<Record<string, unknown>>;
  props: SnippetPanelProps;
}

function setup(overrides: Partial<SnippetPanelProps> = {}): Setup {
  const storage = new MemoryStorage();
  const ports: FakePort[] = [];
  const sent: string[] = [];
  const posts: Array<Record<string, unknown>> = [];
  const focused = { value: false };
  let counter = 0;
  const props: SnippetPanelProps = {
    sessionId: SID,
    manifest: manifest(),
    html: "<p>a</p>",
    listingKey: "k1",
    fetching: false,
    session: { canSend: true, state: "working", queuedMessages: [] },
    messages: [],
    bridge: {
      storage,
      now: () => NOW,
      uuid: () => `req-${String((counter += 1)).padStart(8, "0")}`,
      nonce: () => `nonce-${(counter += 1)}`,
      loadSdk: () => Promise.resolve("/* sdk */"),
      getFonts: () => [],
      getTheme: () => ({ mode: "dark", tokens: {} }) as unknown as SnippetTheme,
      isFrameFocused: () => focused.value,
      postToFrame: (message) => posts.push(message as Record<string, unknown>),
      createChannel: (): SnippetChannel => {
        const hostPort = new FakePort();
        ports.push(hostPort);
        return { hostPort, framePort: {} };
      },
      send: (prompt) => {
        sent.push(prompt);
        return Promise.resolve({ kind: "response", status: 409 });
      },
    },
    ...overrides,
  };
  return { storage, ports, sent, focused, posts, props };
}

async function mount(s: Setup): Promise<{ port: FakePort; frame: HTMLIFrameElement }> {
  const view = render(<SnippetPanel {...s.props} />);
  void view;
  const frame = (await screen.findByTitle("Picker")) as HTMLIFrameElement;
  const nonce = /nonce:"([^"]+)"/.exec(frame.getAttribute("srcdoc") ?? "")?.[1];
  await act(async () => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "spur:hello", protocolVersion: 1, nonce },
        source: frame.contentWindow,
      }),
    );
  });
  const port = s.ports[s.ports.length - 1] as FakePort;
  return { port, frame };
}

function invoke(port: FakePort, actionId = "go", payload: unknown = { note: "x" }): void {
  act(() => port.emit({ type: "invoke", callId: "c1", actionId, payload }));
}

function record(
  status: SnippetActionStatus,
  extra: Partial<SnippetActionRecord> = {},
): SnippetActionRecord {
  return {
    requestId: "req-00000099",
    actionId: "go",
    status,
    prompt: "p",
    instanceId: "inst-00000001",
    baseRevision: 1,
    dispatchedAt: NOW - 5000,
    ...extra,
  };
}

function seedRecord(storage: MemoryStorage, partial: Partial<SnippetRecord>): void {
  const full: SnippetRecord = {
    instanceId: "inst-00000001",
    lastRevision: 1,
    unconfirmedRevision: null,
    state: { app: null, controls: [] },
    action: null,
    updatedAt: NOW,
    ...partial,
  };
  storage.data.set(recordKey(SID, "picker"), JSON.stringify(full));
}

beforeEach(() => {
  dialog.setInline.mockClear();
  dialog.enterFullscreen.mockClear();
  dialog.exitFullscreen.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("SnippetPanel structure", () => {
  it("renders iframe, confirm strip and status line in that order inside the panel element", async () => {
    const s = setup();
    const { port } = await mount(s);
    invoke(port);
    const panel = document.querySelector("[data-snippet-panel]") as HTMLElement;
    const frame = within(panel).getByTitle("Picker");
    const strip = within(panel).getByLabelText("Confirm snippet action");
    const status = within(panel)
      .getByText("Confirm to send")
      .closest("[data-snippet-status]") as HTMLElement;
    const follows = (a: Node, b: Node) =>
      (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    expect(follows(frame, strip)).toBe(true);
    expect(follows(strip, status)).toBe(true);
    expect(frame.closest("dialog")).toBe(strip.closest("dialog"));
    expect(strip.closest("[data-snippet-panel]")).toBe(panel);
  });

  it("keeps a zero-height live region before the first action, with no text and no border", async () => {
    const s = setup();
    await mount(s);
    const panel = document.querySelector("[data-snippet-panel]") as HTMLElement;
    const region = panel.querySelector('dialog > [role="status"]') as HTMLElement;
    expect(region).not.toBeNull();
    expect(region.textContent).toBe("");
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region.className).toContain("h-0");
    expect(region.className).not.toContain("border");
  });

  it("sets the iframe to allow-scripts only, with no tabindex and no autofocus", async () => {
    const s = setup();
    const { frame } = await mount(s);
    expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    expect(frame).not.toHaveAttribute("tabindex");
    expect(frame).not.toHaveAttribute("autofocus");
    expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");
    expect(frame.getAttribute("srcdoc")?.indexOf("Content-Security-Policy")).toBeLessThan(
      frame.getAttribute("srcdoc")?.indexOf("/* sdk */") ?? 0,
    );
  });

  it("opens the dialog inline through snippet-dialog and routes the toggle through it", async () => {
    const s = setup();
    await mount(s);
    expect(dialog.setInline).toHaveBeenCalledWith(document.querySelector("dialog"));
    fireEvent.click(screen.getByRole("button", { name: "Open Picker fullscreen" }));
    expect(dialog.enterFullscreen).toHaveBeenCalledTimes(1);
    const [dlg, frame, close] = dialog.enterFullscreen.mock.calls[0] as [
      HTMLElement,
      HTMLElement,
      HTMLElement,
    ];
    expect(dlg.tagName).toBe("DIALOG");
    expect(frame.tagName).toBe("IFRAME");
    expect(close).toBe(screen.getByRole("button", { name: "Exit fullscreen" }));
    expect(dlg.firstElementChild).toContainElement(close);
    fireEvent.click(close);
    expect(dialog.exitFullscreen).toHaveBeenCalledTimes(1);
    expect(dialog.exitFullscreen.mock.calls[0]?.[1]).toBe(
      screen.getByRole("button", { name: "Open Picker fullscreen" }),
    );
  });

  it("never renders open or autofocus on the dialog or close button", async () => {
    const s = setup();
    await mount(s);
    const dlg = document.querySelector("dialog") as HTMLDialogElement;
    expect(dlg.hasAttribute("autofocus")).toBe(false);
    expect(screen.getByRole("button", { name: "Exit fullscreen" }).hasAttribute("autofocus")).toBe(
      false,
    );
  });
});

describe("confirm strip", () => {
  it("shows the D7 reason text for each reason", async () => {
    const cases: Array<[SnippetConfirmReason, (s: Setup) => string]> = [
      ["declared", () => "danger"],
      ["no_focus", () => "go"],
      [
        "repeat_in_revision",
        (s) => {
          s.focused.value = true;
          seedRecord(s.storage, { unconfirmedRevision: 1 });
          return "go";
        },
      ],
      [
        "budget",
        (s) => {
          s.focused.value = true;
          s.storage.data.set(budgetKey(SID), JSON.stringify({ unconfirmed: 10, updatedAt: NOW }));
          return "go";
        },
      ],
      [
        "storage_unavailable",
        (s) => {
          s.focused.value = true;
          return "go";
        },
      ],
    ];
    for (const [reason, prepare] of cases) {
      const s = setup();
      const actionId = prepare(s);
      const { port } = await mount(s);
      if (reason === "storage_unavailable") s.storage.failAll = true;
      invoke(port, actionId);
      const strip = screen.getByLabelText("Confirm snippet action");
      expect(strip).toHaveTextContent(SNIPPET_CONFIRM_REASON_TEXT[reason]);
      expect(s.sent).toHaveLength(0);
      document.body.innerHTML = "";
    }
  });

  it("shows the action label, id and payload summary with the full payload collapsed", async () => {
    const s = setup();
    const { port } = await mount(s);
    invoke(port, "go", { note: "hello" });
    const strip = screen.getByLabelText("Confirm snippet action");
    expect(within(strip).getByText("Go")).toBeInTheDocument();
    expect(within(strip).getByText("go")).toBeInTheDocument();
    expect(within(strip).getByText("note")).toBeInTheDocument();
    expect(within(strip).getByText('"hello"')).toBeInTheDocument();
    expect((strip.querySelector("details") as HTMLDetailsElement).open).toBe(false);
    expect(strip.querySelector("pre")?.textContent).toBe(
      JSON.stringify({ note: "hello" }, null, 2),
    );
  });

  it("ignores untrusted Send and Discard clicks", async () => {
    const s = setup();
    const { port } = await mount(s);
    invoke(port);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(s.sent).toHaveLength(0);
    expect(screen.getByLabelText("Confirm snippet action")).toBeInTheDocument();
    expect(port.toFrame.filter((message) => message.type === "invoke-result")).toHaveLength(0);
  });

  it("does not move focus when the strip appears", async () => {
    const s = setup();
    const { port, frame } = await mount(s);
    const before = document.activeElement;
    invoke(port);
    expect(document.activeElement).toBe(before);
    expect(document.activeElement).not.toBe(frame);
  });
});

describe("status line", () => {
  const cases: Array<
    [SnippetActionStatus, string, "alert" | "status", Partial<SnippetActionRecord>]
  > = [
    ["accepted", "Sent", "status", { acceptedAt: NOW }],
    ["queued", "Queued", "status", { acceptedAt: NOW }],
    ["processing", "Agent working", "status", { acceptedAt: NOW }],
    ["completed", "Done", "status", {}],
    ["replaced", "Replaced", "status", {}],
    ["error", "Send failed · HTTP 409", "alert", { httpStatus: 409 }],
    ["delivery_unknown", "Delivery unknown", "alert", {}],
    ["timeout", "No reply in 15 min", "status", { acceptedAt: NOW - 3_600_000 }],
  ];
  it.each(cases)("%s reads %s with role %s", async (status, label, role, extra) => {
    const s = setup();
    seedRecord(s.storage, { action: record(status, extra) });
    await mount(s);
    const line = document.querySelector(`[data-snippet-status="${status}"]`) as HTMLElement;
    expect(line).not.toBeNull();
    expect(line).toHaveAttribute("role", role);
    expect(line).toHaveTextContent(label);
    expect(line).toHaveTextContent("Go");
  });

  it("offers a host Retry on error, delivery_unknown and timeout only; untrusted clicks are ignored", async () => {
    const s = setup();
    seedRecord(s.storage, { action: record("error", { httpStatus: 409 }) });
    await mount(s);
    const retry = screen.getByRole("button", { name: "Retry" });
    fireEvent.click(retry);
    expect(s.sent).toHaveLength(0);
    document.body.innerHTML = "";
    const done = setup();
    seedRecord(done.storage, { action: record("completed") });
    await mount(done);
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("shows Confirm to send with role status while a confirm is pending", async () => {
    const s = setup();
    const { port } = await mount(s);
    invoke(port);
    const line = document.querySelector('[data-snippet-status="awaiting_confirm"]') as HTMLElement;
    expect(line).toHaveAttribute("role", "status");
    expect(line).toHaveTextContent("Confirm to send");
  });
});

describe("error cards and banner", () => {
  it("offers Reload on hello_timeout and ignores untrusted clicks", async () => {
    vi.useFakeTimers();
    const s = setup();
    render(<SnippetPanel {...s.props} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(screen.getByText("No connection")).toBeInTheDocument();
    expect(screen.getByText("Snippet did not connect in 10 s.")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(screen.getByText("No connection")).toBeInTheDocument();
    expect(s.sent).toHaveLength(0);
  });

  it("shows navigated with Reload after a second iframe load, and flood after 101 messages", async () => {
    const nav = setup();
    const { frame } = await mount(nav);
    act(() => {
      fireEvent.load(frame);
      fireEvent.load(frame);
    });
    expect(screen.getByText("Navigated")).toBeInTheDocument();
    expect(screen.getByText("Snippet left its page. Panel stopped.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
    document.body.innerHTML = "";
    const flood = setup();
    const { port } = await mount(flood);
    act(() => {
      for (let i = 0; i < 101; i += 1) port.emit({ type: "resize", height: 200 });
    });
    expect(screen.getByText("Flood")).toBeInTheDocument();
    expect(screen.getByText("Over 100 messages in 10 s. Panel stopped.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
  });

  it("shows the conflict banner between header and iframe and keeps the first copy", async () => {
    const s = setup();
    const { rerender } = render(<SnippetPanel {...s.props} />);
    await screen.findByTitle("Picker");
    rerender(<SnippetPanel {...s.props} html="<p>changed</p>" />);
    const banner = await screen.findByText("Revision conflict");
    const alert = banner.closest('[role="alert"]') as HTMLElement;
    expect(alert).toHaveTextContent(
      "Revision 1 changed in place. Showing the first copy. Actions blocked until revision 2.",
    );
    const heading = screen.getByText("Picker", { selector: "div" });
    const frame = screen.getByTitle("Picker");
    const follows = (a: Node, b: Node) =>
      (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    expect(follows(heading, alert)).toBe(true);
    expect(follows(alert, frame)).toBe(true);
    expect(frame.getAttribute("srcdoc")).toContain("<p>a</p>");
    expect(frame.getAttribute("srcdoc")).not.toContain("changed");
  });
});

describe("theme, fullscreen failure and refused files", () => {
  it("posts the theme to the snippet when the app theme changes", async () => {
    const s = setup();
    function Switch() {
      const { setMode } = useTheme();
      return (
        <button onClick={() => setMode("dark")} type="button">
          Go dark
        </button>
      );
    }
    render(
      <ThemeProvider>
        <Switch />
        <SnippetPanel {...s.props} />
      </ThemeProvider>,
    );
    const frame = (await screen.findByTitle("Picker")) as HTMLIFrameElement;
    const nonce = /nonce:"([^"]+)"/.exec(frame.getAttribute("srcdoc") ?? "")?.[1];
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "spur:hello", protocolVersion: 1, nonce },
          source: frame.contentWindow,
        }),
      );
    });
    const port = s.ports[s.ports.length - 1] as FakePort;
    expect(port.toFrame.filter((m) => m.type === "theme")).toHaveLength(0);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Go dark" }));
      await Promise.resolve();
    });
    await waitFor(() => expect(port.toFrame.filter((m) => m.type === "theme")).toHaveLength(1));
    document.documentElement.removeAttribute("data-theme");
  });

  it("an error while fullscreen releases the body scroll lock and runs the dialog exit path", async () => {
    const s = setup();
    const { frame } = await mount(s);
    fireEvent.click(screen.getByRole("button", { name: "Open Picker fullscreen" }));
    expect(dialog.enterFullscreen).toHaveBeenCalledTimes(1);
    expect(document.body.style.overflow).toBe("hidden");
    act(() => {
      fireEvent.load(frame);
      fireEvent.load(frame);
    });
    expect(screen.getByText("Navigated")).toBeInTheDocument();
    expect(dialog.exitFullscreen).toHaveBeenCalledTimes(1);
    expect(document.body.style.overflow).not.toBe("hidden");
  });

  it("reports a refused lower revision through onApplyResult", async () => {
    const s = setup();
    s.props = { ...s.props, manifest: manifest({ revision: 3 }) };
    const results: string[] = [];
    const { rerender } = render(
      <SnippetPanel {...s.props} onApplyResult={(r) => results.push(r)} />,
    );
    await screen.findByTitle("Picker");
    rerender(
      <SnippetPanel
        {...s.props}
        manifest={manifest({ revision: 2 })}
        html="<p>old</p>"
        onApplyResult={(r) => results.push(r)}
      />,
    );
    await waitFor(() => expect(results).toContain("lower_revision"));
    expect(screen.getByTitle("Picker").getAttribute("srcdoc")).not.toContain("<p>old</p>");
  });
});
