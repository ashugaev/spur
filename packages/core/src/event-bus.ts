import type { EventBus } from "./types.js";

export function createEventBus(): EventBus {
  const listeners = new Map<string, Set<(data: unknown) => void>>();

  function getOrCreate(event: string) {
    let set = listeners.get(event);
    if (!set) {
      set = new Set();
      listeners.set(event, set);
    }
    return set;
  }

  return {
    emit(event: string, data?: unknown): void {
      const set = listeners.get(event);
      if (set) {
        for (const handler of set) {
          handler(data);
        }
      }
    },

    on(event: string, handler: (data: unknown) => void): () => void {
      const set = getOrCreate(event);
      set.add(handler);
      return () => {
        set.delete(handler);
      };
    },

    once(event: string, handler: (data: unknown) => void): () => void {
      const set = getOrCreate(event);
      const wrapped = (data: unknown) => {
        set.delete(wrapped);
        handler(data);
      };
      set.add(wrapped);
      return () => {
        set.delete(wrapped);
      };
    },
  };
}
