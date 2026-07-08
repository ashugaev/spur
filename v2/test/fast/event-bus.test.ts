import { afterEach, describe, expect, it, vi } from "vitest";
import { EventBus } from "../../src/event-bus.js";
import type { SpurEvent } from "../../src/event-sources/types.js";

function makeEvent(name: string): SpurEvent {
  return { name, projectId: "proj", sourceId: "src" };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("EventBus", () => {
  it("delivers an emitted event to a subscribed listener", () => {
    const bus = new EventBus();
    const received: SpurEvent[] = [];
    bus.subscribe((event) => received.push(event));
    const event = makeEvent("ping");

    bus.emit(event);

    expect(received).toEqual([event]);
  });

  it("stops delivering events after unsubscribe", () => {
    const bus = new EventBus();
    const received: SpurEvent[] = [];
    const unsubscribe = bus.subscribe((event) => received.push(event));

    unsubscribe();
    bus.emit(makeEvent("ping"));

    expect(received).toEqual([]);
  });

  it("isolates a throwing listener so siblings still receive events", () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const bus = new EventBus();
    const received: SpurEvent[] = [];
    bus.subscribe(() => {
      throw new Error("boom");
    });
    bus.subscribe((event) => received.push(event));

    const event = makeEvent("ping");
    bus.emit(event);

    expect(received).toEqual([event]);
  });

  it("logs listener failures through writeStderr", () => {
    const writeSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const bus = new EventBus();
    bus.subscribe(() => {
      throw new Error("boom");
    });

    bus.emit(makeEvent("ping"));

    const calls = writeSpy.mock.calls.map((call) => String(call[0]));
    expect(
      calls.some((message) => message.includes("[spur:event-bus] listener failed: boom")),
    ).toBe(true);
  });
});
