"use client";
import { useEffect, useRef, useState } from "react";

/** Eases a displayed number toward `target` whenever it changes, so counters tick instead of jump. */
export function useTween(target: number, ms = 700): number {
  const [value, setValue] = useState(target);
  const shown = useRef(target);

  useEffect(() => {
    const from = shown.current;
    if (from === target) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const duration = reduced ? 0 : ms;
    const startedAt = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const p = duration > 0 ? Math.min(1, (now - startedAt) / duration) : 1;
      const eased = 1 - Math.pow(1 - p, 3);
      const v = from + (target - from) * eased;
      shown.current = v;
      setValue(v);
      if (p < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target, ms]);

  return value;
}

/**
 * Follows the newest run index one run at a time, so when several runs land at once (a burst of
 * events, or opening the tab mid-night) the screen steps through real states instead of
 * interpolating between them. Every number and the chart read the tick at this index.
 */
export function usePlayhead(target: number, maxMs = 800): number {
  const [index, setIndex] = useState(target);
  const shown = useRef(target);

  useEffect(() => {
    const from = shown.current;
    if (from === target) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const steps = Math.abs(target - from);
    const dir = Math.sign(target - from);
    // Going backwards never happens within one night; jump straight there if it does.
    const perStep = reduced || dir < 0 ? 0 : Math.min(60, maxMs / steps);
    const startedAt = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const k = perStep > 0 ? Math.min(steps, 1 + Math.floor((now - startedAt) / perStep)) : steps;
      const v = from + dir * k;
      if (v !== shown.current) {
        shown.current = v;
        setIndex(v);
      }
      if (k < steps) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target, maxMs]);

  return index;
}
