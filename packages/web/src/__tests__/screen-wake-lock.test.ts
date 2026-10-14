import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Hold = () => () => void;

class FakeSentinel extends EventTarget {
  release = vi.fn(async () => {
    this.dispatchEvent(new Event("release"));
  });
}

let hold: Hold;
let releases: Array<() => void>;
let visibility: DocumentVisibilityState;
let request: ReturnType<typeof vi.fn>;
let sentinels: FakeSentinel[];
const savedNavigator = Object.getOwnPropertyDescriptor(navigator, "wakeLock");
const savedVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");

function restore(target: object, key: string, saved: PropertyDescriptor | undefined) {
  if (saved) Object.defineProperty(target, key, saved);
  else Reflect.deleteProperty(target, key);
}

function stubWakeLock(value: unknown) {
  Object.defineProperty(navigator, "wakeLock", { configurable: true, value });
}

function setVisibility(next: DocumentVisibilityState) {
  visibility = next;
  document.dispatchEvent(new Event("visibilitychange"));
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(async () => {
  vi.resetModules();
  visibility = "visible";
  sentinels = [];
  releases = [];
  request = vi.fn(async () => {
    const s = new FakeSentinel();
    sentinels.push(s);
    return s;
  });
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
  stubWakeLock({ request });
  const { holdScreenWakeLock } = await import("@/lib/screen-wake-lock");
  hold = () => {
    const release = holdScreenWakeLock();
    releases.push(release);
    return release;
  };
});

afterEach(() => {
  for (const release of releases) release();
  restore(navigator, "wakeLock", savedNavigator);
  restore(document, "visibilityState", savedVisibility);
  vi.restoreAllMocks();
});

describe("holdScreenWakeLock", () => {
  it("acquires a screen lock", async () => {
    const release = hold();
    await flush();
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("screen");
    release();
  });

  it("waits for visibility, then acquires", async () => {
    visibility = "hidden";
    const release = hold();
    await flush();
    expect(request).not.toHaveBeenCalled();
    setVisibility("visible");
    await flush();
    expect(request).toHaveBeenCalledTimes(1);
    release();
  });

  it("re-acquires after a system release on next visible", async () => {
    const release = hold();
    await flush();
    sentinels[0]?.dispatchEvent(new Event("release"));
    await flush();
    expect(request).toHaveBeenCalledTimes(1);
    setVisibility("visible");
    await flush();
    expect(request).toHaveBeenCalledTimes(2);
    release();
  });

  it("releases at zero holders and removes the listener", async () => {
    const removeSpy = vi.spyOn(document, "removeEventListener");
    const release = hold();
    await flush();
    release();
    expect(sentinels[0]?.release).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
    setVisibility("visible");
    await flush();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("shares one sentinel across overlapping holders", async () => {
    const a = hold();
    const b = hold();
    await flush();
    expect(request).toHaveBeenCalledTimes(1);
    a();
    expect(sentinels[0]?.release).not.toHaveBeenCalled();
    b();
    expect(sentinels[0]?.release).toHaveBeenCalledTimes(1);
  });

  it("does nothing when unsupported", async () => {
    stubWakeLock(undefined);
    const release = hold();
    await flush();
    expect(() => release()).not.toThrow();
  });

  it("swallows a NotAllowedError rejection", async () => {
    request.mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"));
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const release = hold();
    await flush();
    await new Promise((r) => setTimeout(r, 0));
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
    release();
  });

  it("releases a sentinel that resolves after the last holder left", async () => {
    const release = hold();
    release();
    await flush();
    expect(sentinels[0]?.release).toHaveBeenCalledTimes(1);
  });

  it("dedupes requests while one is pending", async () => {
    hold();
    setVisibility("visible");
    setVisibility("visible");
    await flush();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("ignores a double release", async () => {
    const a = hold();
    const b = hold();
    await flush();
    a();
    a();
    expect(sentinels[0]?.release).not.toHaveBeenCalled();
    b();
    expect(sentinels[0]?.release).toHaveBeenCalledTimes(1);
  });

  it("treats a synchronous request throw as a silent failure", async () => {
    request.mockImplementationOnce(() => {
      throw new Error("sync");
    });
    expect(() => hold()).not.toThrow();
    await flush();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("attaches a catch handler to the sentinel release", async () => {
    const release = hold();
    await flush();
    const s = sentinels[0];
    if (!s) throw new Error("no sentinel");
    const catchSpy = vi.fn();
    s.release.mockReturnValueOnce({ catch: catchSpy } as unknown as Promise<void>);
    release();
    expect(catchSpy).toHaveBeenCalledTimes(1);
  });
});
