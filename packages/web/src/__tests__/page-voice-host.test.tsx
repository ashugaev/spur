import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PageVoiceHost } from "@/components/PageVoiceHost";

vi.mock("@/components/ChatVoiceControls", () => ({
  ChatVoiceControls: ({
    onTranscribed,
    onState,
  }: {
    onTranscribed: (text: string) => void;
    onState: (state: { starting: boolean; unavailable: boolean; error: string | null }) => void;
  }) => (
    <>
      <button onClick={() => onState({ starting: true, unavailable: false, error: null })}>
        Start
      </button>
      <button onClick={() => onTranscribed("voice")}>Dictate</button>
    </>
  ),
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});
describe("trusted Page voice frame", () => {
  it("requires same-origin parent and full instance identity before rendering controls", () => {
    window.history.replaceState(null, "", "/page-voice?page=one&chat=chat-one&nonce=nonce-123456");
    const parent = { postMessage: vi.fn() };
    vi.stubGlobal("parent", parent);
    const observe = vi.fn();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      height: 108,
    } as DOMRect);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe = observe;
        disconnect() {}
      },
    );
    render(<PageVoiceHost />);
    expect(parent.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "spur:voice-ready" }),
      window.location.origin,
    );
    const data = {
      type: "spur:voice-connect",
      page: "one",
      chat: "chat-one",
      nonce: "nonce-123456",
    };
    function send(origin: string, payload = data) {
      act(() =>
        window.dispatchEvent(
          new MessageEvent("message", {
            origin,
            source: parent as unknown as Window,
            data: payload,
          }),
        ),
      );
    }
    send("https://foreign.test");
    send(window.location.origin, { ...data, nonce: "bad" });
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    send(window.location.origin);
    expect(observe).toHaveBeenCalledWith(
      screen.getByRole("button", { name: "Dictate" }).parentElement,
    );
    expect(parent.postMessage).toHaveBeenCalledWith(
      { ...data, type: "spur:voice-size", height: 108 },
      window.location.origin,
    );
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(parent.postMessage).toHaveBeenCalledWith(
      { ...data, type: "spur:voice-state", starting: true, unavailable: false, error: null },
      window.location.origin,
    );
    fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
    expect(parent.postMessage).toHaveBeenCalledWith(
      { ...data, type: "spur:voice-transcript", text: "voice" },
      window.location.origin,
    );
  });
});
