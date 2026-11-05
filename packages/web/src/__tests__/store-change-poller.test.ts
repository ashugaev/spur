// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createStoreChangePoller,
  STORE_POLL_INTERVAL_MS,
  type StoreChangeEvent,
  type StoreChangesResponse,
} from "@/lib/store-change-poller";

function rig() {
  const calls: Array<{ store: string; since: number }> = [];
  const replies = new Map<string, StoreChangesResponse[]>();
  const poller = createStoreChangePoller({
    fetchChanges: (store, since) => {
      calls.push({ store, since });
      const next = replies.get(store)?.shift();
      return next ? Promise.resolve(next) : Promise.resolve({ changes: [], lastSeq: since });
    },
  });
  const queue = (store: string, ...pages: StoreChangesResponse[]) =>
    replies.set(store, [...(replies.get(store) ?? []), ...pages]);
  return { poller, calls, queue };
}

const row = (seq: number, collection = "items") => ({
  seq,
  collection,
  id: `d${seq}`,
  op: "set" as const,
  rev: 1,
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("store change poller", () => {
  it("polls each subscribed store every 2000 ms with its own cursor", async () => {
    const { poller, calls, queue } = rig();
    queue("page:a", { changes: [], lastSeq: 7 }, { changes: [row(8), row(9)], lastSeq: 9 });
    queue("session:s", { changes: [], lastSeq: 3 });
    const seenA: StoreChangeEvent[] = [];
    poller.subscribe("page:a", (event) => seenA.push(event));
    poller.subscribe("session:s", () => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([
      { store: "page:a", since: 0 },
      { store: "session:s", since: 0 },
    ]);
    expect(seenA).toEqual([]);
    await vi.advanceTimersByTimeAsync(STORE_POLL_INTERVAL_MS - 1);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls.slice(2)).toEqual([
      { store: "page:a", since: 7 },
      { store: "session:s", since: 3 },
    ]);
    expect(seenA).toEqual([{ type: "changes", changes: [row(8), row(9)] }]);
    await vi.advanceTimersByTimeAsync(STORE_POLL_INTERVAL_MS);
    expect(calls.slice(4)).toEqual([
      { store: "page:a", since: 9 },
      { store: "session:s", since: 3 },
    ]);
  });

  it("serves N subscribers of one store from one fetch", async () => {
    const { poller, calls, queue } = rig();
    queue("page:a", { changes: [], lastSeq: 1 }, { changes: [row(2)], lastSeq: 2 });
    const one: StoreChangeEvent[] = [];
    const two: StoreChangeEvent[] = [];
    poller.subscribe("page:a", (event) => one.push(event));
    poller.subscribe("page:a", (event) => two.push(event));
    await vi.advanceTimersByTimeAsync(STORE_POLL_INTERVAL_MS);
    expect(calls).toHaveLength(2);
    expect(one).toEqual(two);
    expect(one).toHaveLength(1);
  });

  it("emits reset and moves the cursor to lastSeq", async () => {
    const { poller, calls, queue } = rig();
    queue("page:a", { changes: [], lastSeq: 50 }, { changes: [], lastSeq: 4, reset: true });
    const seen: StoreChangeEvent[] = [];
    poller.subscribe("page:a", (event) => seen.push(event));
    await vi.advanceTimersByTimeAsync(2 * STORE_POLL_INTERVAL_MS);
    expect(seen).toEqual([{ type: "reset" }]);
    expect(calls[2]).toEqual({ store: "page:a", since: 4 });
  });

  it("stops a store's timer when its last subscriber leaves", async () => {
    const { poller, calls } = rig();
    const offOne = poller.subscribe("page:a", () => undefined);
    const offTwo = poller.subscribe("page:a", () => undefined);
    await vi.advanceTimersByTimeAsync(0);
    offOne();
    await vi.advanceTimersByTimeAsync(STORE_POLL_INTERVAL_MS);
    expect(calls).toHaveLength(2);
    expect(poller.activeStores()).toEqual(["page:a"]);
    offTwo();
    expect(poller.activeStores()).toEqual([]);
    await vi.advanceTimersByTimeAsync(10 * STORE_POLL_INTERVAL_MS);
    expect(calls).toHaveLength(2);
  });

  it("keeps the cursor and polls again after a failed fetch", async () => {
    let fail = false;
    const calls: number[] = [];
    const poller = createStoreChangePoller({
      fetchChanges: (_store, since) => {
        calls.push(since);
        if (fail) return Promise.reject(new Error("down"));
        return Promise.resolve({ changes: [], lastSeq: 5 });
      },
    });
    poller.subscribe("page:a", () => undefined);
    await vi.advanceTimersByTimeAsync(0);
    fail = true;
    await vi.advanceTimersByTimeAsync(STORE_POLL_INTERVAL_MS);
    fail = false;
    await vi.advanceTimersByTimeAsync(STORE_POLL_INTERVAL_MS);
    expect(calls).toEqual([0, 5, 5]);
  });
});
