"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Loads data whenever `version` changes, at most once per `minGapMs` (leading + trailing),
 * so a burst of stats_updated events from the time-lapse turns into one fetch per second.
 * The previous result stays on screen while a refetch is in flight.
 */
export function useThrottledLoad<T>(load: () => Promise<T>, version: number, minGapMs: number, enabled = true) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastAt = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seq = useRef(0);
  const alive = useRef(true);

  const fire = useCallback(() => {
    lastAt.current = Date.now();
    const id = ++seq.current;
    load().then(
      (d) => {
        if (!alive.current || id !== seq.current) return;
        setData(d);
        setError(null);
      },
      (err: unknown) => {
        if (!alive.current || id !== seq.current) return;
        setError(err instanceof Error ? err.message : String(err));
      },
    );
  }, [load]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, []);

  useEffect(() => {
    if (!enabled || timer.current) return;
    const wait = Math.max(0, lastAt.current + minGapMs - Date.now());
    timer.current = setTimeout(() => {
      timer.current = null;
      fire();
    }, wait);
  }, [version, minGapMs, enabled, fire]);

  /** Fetch now, ignoring the throttle (after a user action). */
  const refresh = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    fire();
  }, [fire]);

  return { data, error, refresh };
}

function translateY(el: HTMLElement): number {
  const t = getComputedStyle(el).transform;
  if (!t || t === "none") return 0;
  return new DOMMatrixReadOnly(t).m42;
}

/**
 * FLIP for a reordered list: children marked `data-flip="<key>"` slide from where they were
 * drawn to their new slot. Picks up mid-flight rows from their current on-screen offset.
 */
export function useFlip(container: RefObject<HTMLElement | null>, orderKey: string, durationMs = 560) {
  const tops = useRef(new Map<string, number>());

  useLayoutEffect(() => {
    const root = container.current;
    if (!root) return;
    const reduce = prefersReducedMotion();
    const next = new Map<string, number>();
    const moved: { el: HTMLElement; delta: number }[] = [];

    root.querySelectorAll<HTMLElement>("[data-flip]").forEach((el) => {
      const k = el.dataset.flip ?? "";
      const top = el.offsetTop;
      next.set(k, top);
      const prev = tops.current.get(k);
      if (prev === undefined || reduce) return;
      const delta = prev + translateY(el) - top;
      if (Math.abs(delta) < 0.5) return;
      moved.push({ el, delta });
    });
    tops.current = next;
    if (!moved.length) return;

    for (const { el, delta } of moved) {
      el.style.transition = "none";
      el.style.transform = `translateY(${delta}px)`;
      el.style.zIndex = delta > 0 ? "2" : "1";
    }
    void root.offsetHeight;
    for (const { el } of moved) {
      el.style.transition = `transform ${durationMs}ms cubic-bezier(0.2, 0.7, 0.1, 1)`;
      el.style.transform = "";
      const done = (e: TransitionEvent) => {
        if (e.target !== el || e.propertyName !== "transform") return;
        el.style.zIndex = "";
        el.style.transition = "";
        el.removeEventListener("transitionend", done);
      };
      el.addEventListener("transitionend", done);
    }
  }, [container, orderKey, durationMs]);
}

/** Eases a displayed number toward `value` so scores tick instead of jumping. */
export function useTween(value: number, durationMs = 600): number {
  const [shown, setShown] = useState(value);
  const current = useRef(value);

  useEffect(() => {
    const from = current.current;
    const to = value;
    if (from === to) return;
    const dur = prefersReducedMotion() ? 0 : durationMs;
    const start = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const k = dur ? Math.min(1, (now - start) / dur) : 1;
      const eased = 1 - Math.pow(1 - k, 3);
      const v = k >= 1 ? to : from + (to - from) * eased;
      current.current = v;
      setShown(v);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, durationMs]);

  return shown;
}

/**
 * Plays a one-shot CSS animation class on the element the moment `active` turns true.
 * Done imperatively so a row that later moves in the DOM does not replay it.
 */
export function useOnsetAnimation(ref: RefObject<HTMLElement | null>, active: boolean, className: string) {
  const was = useRef(false);
  useEffect(() => {
    const el = ref.current;
    const rising = active && !was.current;
    was.current = active;
    if (!el || !rising) return;
    el.classList.remove(className);
    void el.offsetWidth;
    el.classList.add(className);
    const clear = () => el.classList.remove(className);
    el.addEventListener("animationend", clear, { once: true });
    return () => el.removeEventListener("animationend", clear);
  }, [ref, active, className]);
}
