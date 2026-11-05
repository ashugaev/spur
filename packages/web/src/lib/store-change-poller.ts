// One change poller per browser tab for dashboard snippet panels: every subscribed
// store is polled over the JSON `GET /api/stores/<store>/changes?since=N` route each
// 2000 ms, so panels hold zero long-lived connections. Ref-counted per store; the
// timer for a store stops with its last subscriber.

export const STORE_POLL_INTERVAL_MS = 2000;

export interface StoreChangeRow {
  seq: number;
  collection: string;
  id: string;
  op: "set" | "delete";
  rev: number;
}

export interface StoreChangesResponse {
  changes: StoreChangeRow[];
  lastSeq: number;
  reset?: true;
}

export type StoreChangeEvent = { type: "changes"; changes: StoreChangeRow[] } | { type: "reset" };
export type StoreChangeListener = (event: StoreChangeEvent) => void;

export interface StoreChangePoller {
  subscribe(store: string, listener: StoreChangeListener): () => void;
  activeStores(): string[];
}

export interface StoreChangePollerDeps {
  fetchChanges(store: string, since: number): Promise<StoreChangesResponse>;
  intervalMs?: number;
}

interface StoreEntry {
  listeners: Set<StoreChangeListener>;
  // null until the first poll fixes the cursor at the store's current lastSeq
  cursor: number | null;
  timer: ReturnType<typeof setTimeout> | undefined;
  inflight: boolean;
}

function isChangesResponse(value: unknown): value is StoreChangesResponse {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return Array.isArray(record.changes) && typeof record.lastSeq === "number";
}

export function createStoreChangePoller(deps: StoreChangePollerDeps): StoreChangePoller {
  const intervalMs = deps.intervalMs ?? STORE_POLL_INTERVAL_MS;
  const entries = new Map<string, StoreEntry>();

  function emit(entry: StoreEntry, event: StoreChangeEvent): void {
    for (const listener of [...entry.listeners]) listener(event);
  }

  function schedule(store: string, entry: StoreEntry): void {
    entry.timer = setTimeout(() => void poll(store, entry), intervalMs);
  }

  async function poll(store: string, entry: StoreEntry): Promise<void> {
    if (entries.get(store) !== entry || entry.inflight) return;
    entry.inflight = true;
    try {
      const page = await deps.fetchChanges(store, entry.cursor ?? 0);
      if (entries.get(store) !== entry || !isChangesResponse(page)) return;
      if (entry.cursor === null) {
        // First poll only fixes the cursor; subscribers read current docs themselves.
        entry.cursor = page.lastSeq;
      } else if (page.reset) {
        entry.cursor = page.lastSeq;
        emit(entry, { type: "reset" });
      } else if (page.changes.length > 0) {
        entry.cursor = page.changes[page.changes.length - 1]!.seq;
        emit(entry, { type: "changes", changes: page.changes });
      }
    } catch {
      // network or daemon error: keep the cursor, try again next tick
    } finally {
      entry.inflight = false;
      if (entries.get(store) === entry) schedule(store, entry);
    }
  }

  return {
    subscribe(store, listener) {
      let entry = entries.get(store);
      if (!entry) {
        entry = { listeners: new Set(), cursor: null, timer: undefined, inflight: false };
        entries.set(store, entry);
        const created = entry;
        void poll(store, created);
      }
      entry.listeners.add(listener);
      const owned = entry;
      return () => {
        owned.listeners.delete(listener);
        if (owned.listeners.size > 0 || entries.get(store) !== owned) return;
        clearTimeout(owned.timer);
        entries.delete(store);
      };
    },
    activeStores: () => [...entries.keys()],
  };
}

async function fetchStoreChanges(store: string, since: number): Promise<StoreChangesResponse> {
  const response = await fetch(
    `/api/stores/${encodeURIComponent(store)}/changes?since=${since}`,
    { cache: "no-store", headers: { accept: "application/json" } },
  );
  if (!response.ok) throw new Error(`changes ${response.status}`);
  return (await response.json()) as StoreChangesResponse;
}

/** The tab-wide poller every snippet panel shares. */
export const storeChangePoller: StoreChangePoller = createStoreChangePoller({
  fetchChanges: fetchStoreChanges,
});
