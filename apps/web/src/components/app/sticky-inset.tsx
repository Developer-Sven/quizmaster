"use client";

import { useEffect, useRef } from "react";

/** Rand, an dem eine Leiste klebt: oben die Kopfzeile, unten die Aktionsleiste. */
export type StickyEdge = "top" | "bottom";

/** Gemeldete Höhen je Rand – beim Seitenwechsel können kurz zwei Leisten gleichzeitig existieren. */
const heights: Record<StickyEdge, Map<symbol, number>> = { top: new Map(), bottom: new Map() };

/** CSS-Variable am Wurzelelement, aus der globals.css das `scroll-padding` des Dokuments bildet. */
export function stickyInsetProperty(edge: StickyEdge): string {
  return `--sticky-${edge}`;
}

/** Größte gemeldete Höhe eines Randes in ganzen Pixeln (aufgerundet), 0 ohne Leiste. */
export function stickyInsetValue(values: Iterable<number>): number {
  return Math.ceil(Math.max(0, ...values));
}

function apply(edge: StickyEdge): void {
  const value = stickyInsetValue(heights[edge].values());
  const style = document.documentElement.style;
  if (value > 0) style.setProperty(stickyInsetProperty(edge), `${value}px`);
  else style.removeProperty(stickyInsetProperty(edge));
}

/**
 * Meldet die Höhe der klebenden Leiste, in der es steht (Elternelement: Kopfzeile bzw. Aktionsleiste), als
 * `scroll-padding` des Dokuments (globals.css). So scrollt der Browser ein per Tab fokussiertes Element nie
 * unter Kopfzeile oder Aktionsleiste (WCAG 2.4.11) – auch wenn die Leisten bei Text-Zoom wachsen.
 */
export function StickyInset({ edge }: { edge: StickyEdge }) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const bar = ref.current?.parentElement;
    if (!bar) return;
    const key = Symbol(edge);
    const update = () => {
      heights[edge].set(key, bar.getBoundingClientRect().height);
      apply(edge);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(bar);
    return () => {
      observer.disconnect();
      heights[edge].delete(key);
      apply(edge);
    };
  }, [edge]);

  return <span ref={ref} hidden />;
}
