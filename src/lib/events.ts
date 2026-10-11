// In-process event bus. The engine publishes; the SSE route fans events out to browsers.
import { EventEmitter } from "node:events";
import type { EngineEvent } from "@/lib/types";

const g = globalThis as unknown as { __axolotlBus?: EventEmitter };

function bus(): EventEmitter {
  if (!g.__axolotlBus) {
    g.__axolotlBus = new EventEmitter();
    g.__axolotlBus.setMaxListeners(200);
  }
  return g.__axolotlBus;
}

export function publish(event: EngineEvent): void {
  bus().emit("event", event);
}

/** A throwing subscriber must never reach the publisher (the engine) or starve the other subscribers. */
export function subscribe(fn: (e: EngineEvent) => void): () => void {
  const safe = (e: EngineEvent) => {
    try {
      fn(e);
    } catch (err) {
      console.error("[events] subscriber failed:", (err as Error)?.message);
    }
  };
  bus().on("event", safe);
  return () => bus().off("event", safe);
}
