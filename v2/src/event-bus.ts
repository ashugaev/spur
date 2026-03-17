import type { SpurEvent } from "./event-sources/types.js";

type EventListener = (event: SpurEvent) => void;

export class EventBus {
  private readonly listeners = new Set<EventListener>();

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: SpurEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[spur:event-bus] listener failed: ${message}`);
      }
    }
  }
}
