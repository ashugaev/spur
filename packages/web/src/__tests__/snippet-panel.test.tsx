import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider, useTheme } from "@/lib/theme-context";
import { SnippetPanel, type SnippetPanelProps } from "@/components/snippets/SnippetPanel";
import type { SnippetChannel } from "@/lib/snippets/snippet-host";
import {
  SNIPPET_CONFIRM_REASON_TEXT,
  type SnippetActionStatus,
  type SnippetConfirmReason,
  type SnippetTheme,
} from "@/lib/snippets/snippet-protocol";
import { budgetKey, recordKey, type SnippetRecord } from "@/lib/snippets/snippet-store";
import { useVoiceInput, type UseVoiceInput } from "@/hooks/useVoiceInput";

vi.mock("@/hooks/useVoiceInput", () => ({ useVoiceInput: vi.fn() }));
function voiceControls(overrides: Partial<UseVoiceInput> = {}): UseVoiceInput {
  return {
    canUseVoice: true,
    recording: false,
    hasRetainedTake: false,
    retainedTakePlaying: false,
    voiceBusy: null,
    voiceModalOpen: false,
    voiceDraft: "",
    voiceError: null,
    setVoiceDraft: vi.fn(),
    openDraft: vi.fn(),
    toggleRecording: vi.fn(),
    playRetainedTake: vi.fn(),
    discardRetainedTake: vi.fn(),
    retryRetainedTake: vi.fn().mockResolvedValue(undefined),
    stopAndSend: vi.fn(),
    cancelRecording: vi.fn(),
    confirmDraft: vi.fn().mockResolvedValue(undefined),
    dismissModal: vi.fn(),
    clearVoiceError: vi.fn(),
    ...overrides,
  };
}
import {
  FakeDaemon,
  FakePoller,
  FakePort,
  manifest,
  MemoryStorage,
  SID,
} from "./fixtures/snippet-host-rig";

const dialog = vi.hoisted(() => ({
  // jsdom has no show/showModal; the stub keeps the declarative open attribute.
  setInline: vi.fn((node: HTMLElement) => node.setAttribute("open", "")),
  enterFullscreen: vi.fn(),
  exitFullscreen: vi.fn(),
}));
vi.mock("@/lib/snippets/snippet-dialog", () => dialog);

const NOW = Date.parse("2026-11-03T10:00:00Z");

interface Setup {
  storage: MemoryStorage;
  daemon: FakeDaemon;
  ports: FakePort[];
  focused: { value: boolean };
  posts: Array<Record<string, unknown>>;
  props: SnippetPanelProps;
  sent(): number;
}

function setup(overrides: Partial<SnippetPanelProps> = {}): Setup {
  const storage = new MemoryStorage();
  const daemon = new FakeDaemon();
  const ports: FakePort[] = [];
  const posts: Array<Record<string, unknown>> = [];
  const focused = { value: false };
  let counter = 0;
  const props: SnippetPanelProps = {
    sessionId: SID,
    manifest: manifest(),
    html: "<p>a</p>",
    session: { canSend: true, state: "working", status: "running" },
    bridge: {
      storage,
      request: (method, url, body) => daemon.handle(method, url, body),
      poller: new FakePoller(),
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
    },
    ...overrides,
  };
  return {
    storage,
    daemon,
    ports,
    focused,
    posts,
    props,
    sent: () => daemon.posts("/actions").length,
  };
}

async function mount(s: Setup): Promise<{ port: FakePort; frame: HTMLIFrameElement }> {
  const before = s.ports.length;
  render(<SnippetPanel {...s.props} />);
  const frame = (await screen.findByTitle("Picker")) as HTMLIFrameElement;
  const nonce = /nonce:"([^"]+)"/.exec(frame.getAttribute("srcdoc") ?? "")?.[1];
  await act(async () => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "spur:hello", protocolVersion: 2, nonce },
        source: frame.contentWindow,
      }),
    );
  });
  await waitFor(() => expect(s.ports.length).toBeGreaterThan(before));
  const port = s.ports[s.ports.length - 1] as FakePort;
  return { port, frame };
}

function invoke(port: FakePort, action = "go", payload: unknown = { note: "x" }): void {
  act(() => port.emit({ type: "invoke", callId: "c1", action, payload }));
}

// Seeds the `_actions` doc the panel restores on mount.
function seedAction(
  daemon: FakeDaemon,
  status: "pending" | "done" | "failed",
  error?: string,
): void {
  const createdAt = new Date(NOW - 5000).toISOString();
  daemon.actions.set("act-seeded-01", {
    id: "act-seeded-01",
    rev: 1,
    createdAt,
    updatedAt: createdAt,
    data: {
      action: "go",
      label: "Go",
      payload: { note: "x" },
      source: { kind: "snippet", snippetId: "picker", instanceId: "inst-00000001", revision: 1 },
      status,
      createdAt,
      ...(error ? { error } : {}),
    },
  });
}

function seedRecord(storage: MemoryStorage, partial: Partial<SnippetRecord>): void {
  const full: SnippetRecord = {
    instanceId: "inst-00000001",
    lastRevision: 1,
    unconfirmedRevision: null,
    updatedAt: NOW,
    ...partial,
  };
  storage.data.set(recordKey(SID, "picker"), JSON.stringify(full));
}

beforeEach(() => {
  vi.mocked(useVoiceInput).mockReset().mockReturnValue(voiceControls());
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  dialog.setInline.mockClear();
  dialog.enterFullscreen.mockClear();
  dialog.exitFullscreen.mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("projected per-input voice", () => {
  function geometry(frame: HTMLIFrameElement) {
    const region = frame.parentElement!;
    const rect = {
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 400,
      bottom: 300,
      width: 400,
      height: 300,
      toJSON() {},
    };
    for (const node of [frame, region]) {
      node.getBoundingClientRect = () => rect;
      Object.defineProperties(node, {
        offsetWidth: { configurable: true, value: 400 },
        offsetHeight: { configurable: true, value: 300 },
        clientWidth: { configurable: true, value: 400 },
        clientHeight: { configurable: true, value: 300 },
      });
    }
  }
  const snapshot = (sequence = 0) => ({
    type: "chat-layout",
    sequence,
    viewport: { width: 400, height: 300 },
    slots: ["one", "two"].map((target, index) => ({
      target,
      rect: { x: 20 + index * 200, y: 100, width: 32, height: 108 },
    })),
  });
  it("starts the unfocused second input, freezes its take through focus and rejects late insertion after placement loss", async () => {
    const s = setup();
    s.props.bridge = { ...s.props.bridge, now: () => Date.now() };
    const cancel = vi.fn();
    const discard = vi.fn();
    const toggle = vi.fn(() =>
      vi
        .mocked(useVoiceInput)
        .mockReturnValue(
          voiceControls({
            voiceBusy: "starting",
            cancelRecording: cancel,
            discardRetainedTake: discard,
          }),
        ),
    );
    vi.mocked(useVoiceInput).mockReturnValue(voiceControls({ toggleRecording: toggle }));
    const { frame, port } = await mount(s);
    geometry(frame);
    act(() => {
      port.emit({ type: "chat-register", target: "one" });
      port.emit({ type: "chat-register", target: "two" });
      port.emit(snapshot());
    });
    const buttons = screen.getAllByRole("button", { name: "Start voice recording", exact: true });
    expect(buttons).toHaveLength(2);
    expect(frame.parentElement?.querySelectorAll("[data-voice-target]")).toHaveLength(2);
    fireEvent.click(buttons[1]!);
    expect(toggle).toHaveBeenCalledOnce();
    act(() => port.emit({ type: "chat-focus", target: "one" }));
    expect(
      screen.getAllByRole("button", { name: "Start voice recording", exact: true })[0],
    ).toBeDisabled();
    const callback = vi.mocked(useVoiceInput).mock.calls.at(-1)?.[0].onTranscribed;
    act(() => callback?.("second target"));
    expect(port.toFrame).toContainEqual({
      type: "chat-transcript",
      target: "two",
      text: "second target",
    });
    act(() =>
      port.emit({
        ...snapshot(1),
        slots: [{ target: "one", rect: { x: 20, y: 100, width: 32, height: 108 } }],
      }),
    );
    expect(cancel).toHaveBeenCalled();
    expect(discard).toHaveBeenCalled();
    const sent = port.toFrame.filter((message) => message.type === "chat-transcript").length;
    act(() => callback?.("late"));
    expect(port.toFrame.filter((message) => message.type === "chat-transcript")).toHaveLength(sent);
    expect(
      new Set(vi.mocked(useVoiceInput).mock.calls.map(([options]) => options.contextKey)).size,
    ).toBe(1);
  });
  it("does not reschedule geometry rAF for static inputs and coalesces dirty bursts", async () => {
    const queued = new Map<number, FrameRequestCallback>();
    let next = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      queued.set(++next, callback);
      return next;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => queued.delete(id));
    const s = setup();
    const { frame } = await mount(s);
    geometry(frame);
    expect(queued.size).toBe(1);
    const run = () => {
      const callbacks = [...queued.values()];
      queued.clear();
      act(() => callbacks.forEach((callback) => callback(0)));
    };
    run();
    expect(queued.size).toBe(0);
    for (let i = 0; i < 10; i++) window.dispatchEvent(new Event("scroll"));
    expect(queued.size).toBe(1);
    run();
    expect(queued.size).toBe(0);
  });
  it("expires placements at 750ms and cancels pending capture before accepting a late transcript", async () => {
    const s = setup();
    s.props.bridge = { ...s.props.bridge, now: () => Date.now() };
    const cancel = vi.fn();
    const toggle = vi.fn(() =>
      vi
        .mocked(useVoiceInput)
        .mockReturnValue(voiceControls({ voiceBusy: "starting", cancelRecording: cancel })),
    );
    vi.mocked(useVoiceInput).mockReturnValue(voiceControls({ toggleRecording: toggle }));
    const { frame, port } = await mount(s);
    geometry(frame);
    vi.useFakeTimers();
    act(() => {
      port.emit({ type: "chat-register", target: "one" });
      port.emit({ type: "chat-register", target: "two" });
      port.emit(snapshot());
    });
    fireEvent.click(
      screen.getAllByRole("button", { name: "Start voice recording", exact: true })[0]!,
    );
    const callback = vi.mocked(useVoiceInput).mock.calls.at(-1)?.[0].onTranscribed;
    act(() => vi.advanceTimersByTime(750));
    expect(document.querySelectorAll("[data-voice-target]")).toHaveLength(0);
    expect(cancel).toHaveBeenCalled();
    act(() => callback?.("expired"));
    expect(port.toFrame.filter((message) => message.type === "chat-transcript")).toEqual([]);
  });
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
      if (reason === "storage_unavailable") s.storage.failGet = true;
      invoke(port, actionId);
      const strip = screen.getByLabelText("Confirm snippet action");
      expect(strip).toHaveTextContent(SNIPPET_CONFIRM_REASON_TEXT[reason]);
      expect(s.sent()).toBe(0);
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
    expect(s.sent()).toBe(0);
    expect(screen.getByLabelText("Confirm snippet action")).toBeInTheDocument();
    expect(port.toFrame.filter((message) => message.type === "invoke-result")).toHaveLength(0);
  });

  it("shows an agent message waiting for confirm as inert text with no action status", async () => {
    const s = setup();
    const { port } = await mount(s);
    act(() => port.emit({ type: "agent", op: "send", message: "<b>hi</b>", callId: "a1" }));
    const strip = screen.getByLabelText("Confirm snippet action");
    expect(within(strip).getByText("Message to agent")).toBeInTheDocument();
    expect(strip.querySelector("pre")?.textContent).toBe("<b>hi</b>");
    expect(strip.querySelector("b")).toBeNull();
    expect(document.querySelector("[data-snippet-status]")).toBeNull();
    expect(s.daemon.posts("/agent/send")).toHaveLength(0);
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
    [SnippetActionStatus, string, "alert" | "status", "pending" | "done" | "failed", string?]
  > = [
    ["queued", "Queued", "status", "pending"],
    ["completed", "Done", "status", "done"],
    ["error", "Failed", "alert", "failed", "no film"],
    ["timeout", "No reply in 15 min", "status", "failed", "timeout"],
  ];
  it.each(cases)("%s reads %s with role %s", async (status, label, role, doc, error) => {
    const s = setup({ session: { canSend: true, state: "idle", status: "running" } });
    seedAction(s.daemon, doc, error);
    await mount(s);
    const line = (await waitFor(() => {
      const found = document.querySelector(`[data-snippet-status="${status}"]`);
      expect(found).not.toBeNull();
      return found;
    })) as HTMLElement;
    expect(line).toHaveAttribute("role", role);
    expect(line).toHaveTextContent(label);
    expect(line).toHaveTextContent("Go");
  });

  it("reads Agent working while a pending action's owner is working", async () => {
    const s = setup();
    seedAction(s.daemon, "pending");
    await mount(s);
    await waitFor(() =>
      expect(document.querySelector('[data-snippet-status="processing"]')).toHaveTextContent(
        "Agent working",
      ),
    );
  });

  it("offers a host Retry on error and timeout only; untrusted clicks are ignored", async () => {
    const s = setup();
    seedAction(s.daemon, "failed", "no film");
    await mount(s);
    const retry = await screen.findByRole("button", { name: "Retry" });
    fireEvent.click(retry);
    expect(s.sent()).toBe(0);
    document.body.innerHTML = "";
    const done = setup();
    seedAction(done.daemon, "done");
    await mount(done);
    await waitFor(() =>
      expect(document.querySelector('[data-snippet-status="completed"]')).not.toBeNull(),
    );
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
    expect(s.sent()).toBe(0);
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
          data: { type: "spur:hello", protocolVersion: 2, nonce },
          source: frame.contentWindow,
        }),
      );
    });
    await waitFor(() => expect(s.ports.length).toBeGreaterThan(0));
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

describe("loading state", () => {
  it("shows the panel header with the title and a busy placeholder before the host exists", () => {
    const s = setup();
    render(<SnippetPanel {...s.props} />);
    expect(screen.getByText("Picker", { selector: "div" })).toBeInTheDocument();
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
  });
});

describe("apply results", () => {
  it("reports ignored, conflict and mounted for the same, changed-in-place and higher file", async () => {
    const s = setup();
    const results: string[] = [];
    const ui = (m: ReturnType<typeof manifest>, html: string) => (
      <SnippetPanel {...s.props} html={html} manifest={m} onApplyResult={(r) => results.push(r)} />
    );
    const { rerender } = render(ui(manifest(), "<p>a</p>"));
    await screen.findByTitle("Picker");
    expect(results).toEqual(["ignored"]);
    rerender(ui(manifest(), "<p>changed</p>"));
    await waitFor(() => expect(results).toContain("conflict"));
    rerender(ui(manifest({ revision: 2 }), "<p>b</p>"));
    await waitFor(() => expect(results).toContain("mounted"));
  });
});
