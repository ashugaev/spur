import { describe, expect, it, vi } from "vitest";
import {
  budgetKey,
  pruneSnippetRecords,
  readSnippetBudget,
  readSnippetRecord,
  recordKey,
  writeSnippetBudget,
  writeSnippetRecord,
  type SnippetRecord,
  type SnippetStorage,
} from "@/lib/snippets/snippet-store";

class MemoryStorage implements SnippetStorage {
  data = new Map<string, string>();
  failSet: (key: string, value: string) => boolean = () => false;
  failGet = false;
  get length(): number {
    return this.data.size;
  }
  key(index: number): string | null {
    return [...this.data.keys()][index] ?? null;
  }
  getItem(key: string): string | null {
    if (this.failGet) throw new Error("denied");
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (this.failSet(key, value)) throw new DOMException("full", "QuotaExceededError");
    this.data.set(key, value);
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
}

const NOW = Date.parse("2026-11-03T00:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function record(overrides: Partial<SnippetRecord> = {}): SnippetRecord {
  return {
    instanceId: "inst-00000001",
    lastRevision: 3,
    unconfirmedRevision: 3,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("snippet store", () => {
  it("round-trips a v2 record holding the gate fields only", () => {
    const storage = new MemoryStorage();
    expect(writeSnippetRecord(storage, "s", "p", record())).toBe(true);
    expect(recordKey("s", "p")).toBe("spur:snippet:v2:s:p");
    expect(JSON.parse(storage.data.get(recordKey("s", "p")) ?? "")).toEqual({
      instanceId: "inst-00000001",
      lastRevision: 3,
      unconfirmedRevision: 3,
      updatedAt: NOW,
    });
    expect(readSnippetRecord(storage, "s", "p")).toEqual({ ok: true, value: record() });
  });

  it("record write failure is reported", () => {
    const storage = new MemoryStorage();
    storage.failSet = () => true;
    expect(writeSnippetRecord(storage, "s", "p", record())).toBe(false);
  });

  it("discards malformed JSON and invalid shapes, failing the read once", () => {
    const storage = new MemoryStorage();
    storage.data.set(recordKey("s", "p"), "{nope");
    expect(readSnippetRecord(storage, "s", "p")).toEqual({ ok: false });
    expect(storage.data.has(recordKey("s", "p"))).toBe(false);
    expect(readSnippetRecord(storage, "s", "p")).toEqual({ ok: true, value: null });
    storage.data.set(recordKey("s", "p"), JSON.stringify({ instanceId: 5 }));
    expect(readSnippetRecord(storage, "s", "p")).toEqual({ ok: false });
    storage.data.set(budgetKey("s"), JSON.stringify({ unconfirmed: -1, updatedAt: 1 }));
    expect(readSnippetBudget(storage, "s")).toEqual({ ok: false });
  });

  it("reports a storage throw as a failed read, with no memory fallback", () => {
    const storage = new MemoryStorage();
    expect(writeSnippetBudget(storage, "s", 4, NOW)).toBe(true);
    storage.failGet = true;
    expect(readSnippetBudget(storage, "s")).toEqual({ ok: false });
    expect(readSnippetRecord(storage, "s", "p")).toEqual({ ok: false });
  });

  it("persists the budget across store instances and keeps unset as zero", () => {
    const storage = new MemoryStorage();
    expect(readSnippetBudget(storage, "s")).toEqual({
      ok: true,
      value: { unconfirmed: 0, updatedAt: 0 },
    });
    writeSnippetBudget(storage, "s", 7, NOW);
    expect(readSnippetBudget(storage, "s")).toMatchObject({ ok: true, value: { unconfirmed: 7 } });
  });

  it("budget write failure is reported, not swallowed", () => {
    const storage = new MemoryStorage();
    storage.failSet = () => true;
    expect(writeSnippetBudget(storage, "s", 1, NOW)).toBe(false);
    expect(readSnippetBudget(storage, "s")).toEqual({
      ok: true,
      value: { unconfirmed: 0, updatedAt: 0 },
    });
  });

  it("prunes every v1 key, v2 records older than 7 days, and keeps budget keys of any age", () => {
    const storage = new MemoryStorage();
    writeSnippetRecord(storage, "s", "old", record({ updatedAt: NOW - 8 * DAY }));
    writeSnippetRecord(storage, "s", "fresh", record({ updatedAt: NOW - 6 * DAY }));
    writeSnippetBudget(storage, "s", 3, NOW - 30 * DAY);
    storage.data.set("spur:snippet:v1:s:fresh", JSON.stringify({ updatedAt: NOW }));
    storage.data.set("spur:snippet:v1:s:broken", "{nope");
    storage.data.set("unrelated", "x");
    pruneSnippetRecords(storage, NOW);
    expect([...storage.data.keys()].sort()).toEqual(
      [recordKey("s", "fresh"), budgetKey("s"), "unrelated"].sort(),
    );
  });

  it("prune tolerates a throwing storage", () => {
    const storage = new MemoryStorage();
    storage.failGet = true;
    storage.data.set(recordKey("s", "p"), "x");
    expect(() => pruneSnippetRecords(storage, NOW)).not.toThrow();
    vi.restoreAllMocks();
  });
});
