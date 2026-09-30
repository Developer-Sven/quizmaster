"use client";

import { type RefObject, useEffect, useEffectEvent } from "react";
import { focusableWithin, trapTabKey } from "./focus";

/** Art einer modalen Ebene; von Sheets darf höchstens eines offen sein (docs/09 §5). */
export type ModalKind = "sheet" | "dialog";

interface Layer {
  kind: ModalKind;
}

/** Offene modale Ebenen, zuletzt geöffnete oben. Nur die oberste reagiert auf Escape und Tab. */
const layers: Layer[] = [];
let previousOverflow = "";

function lockScroll(): void {
  if (layers.length === 1) {
    previousOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
  }
}

function unlockScroll(): void {
  if (layers.length === 0) document.documentElement.style.overflow = previousOverflow;
}

/** Anzahl offener Ebenen einer Art (für Tests und die Sheet-Regel). */
export function openLayerCount(kind: ModalKind): number {
  return layers.filter((layer) => layer.kind === kind).length;
}

export interface ModalLayerOptions {
  /** Ebene ist sichtbar und im DOM */
  active: boolean;
  kind: ModalKind;
  /** Container der Ebene (role="dialog"/"alertdialog") */
  containerRef: RefObject<HTMLElement | null>;
  /** Erstes Fokusziel; sonst das erste fokussierbare Element, sonst der Container */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Escape auf der obersten Ebene; ohne Handler bleibt Escape wirkungslos */
  onEscape?: () => void;
}

/**
 * Verhalten modaler Ebenen (docs/09 §5, §12): Fokus hinein, Fokusfalle (Tab/Umschalt+Tab),
 * Escape schließt, Fokus zurück zum Auslöser, Seite scrollt nicht mit. Mehrere Ebenen stapeln sich
 * (Dialog über Sheet); zwei Sheets gleichzeitig sind ein Fehler – Unteransichten wechseln den Inhalt.
 */
export function useModalLayer({ active, kind, containerRef, initialFocusRef, onEscape }: ModalLayerOptions): void {
  const handleEscape = useEffectEvent(() => onEscape?.());

  useEffect(() => {
    const container = containerRef.current;
    if (!active || !container) return;

    if (kind === "sheet" && openLayerCount("sheet") > 0) {
      console.error("Designsystem: Es ist bereits ein Sheet offen – Unteransichten wechseln den Inhalt (docs/09 §5).");
    }
    const layer: Layer = { kind };
    layers.push(layer);
    lockScroll();

    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const firstTarget = initialFocusRef?.current ?? focusableWithin(container)[0] ?? container;
    firstTarget.focus({ preventScroll: true });

    const isTop = () => layers[layers.length - 1] === layer;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isTop()) return;
      if (event.key === "Escape") {
        event.preventDefault();
        handleEscape();
      } else if (event.key === "Tab") {
        trapTabKey(event, container);
      }
    };
    const onFocusIn = (event: FocusEvent) => {
      if (isTop() && event.target instanceof Node && !container.contains(event.target)) {
        (focusableWithin(container)[0] ?? container).focus({ preventScroll: true });
      }
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("focusin", onFocusIn);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("focusin", onFocusIn);
      layers.splice(layers.indexOf(layer), 1);
      unlockScroll();
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    };
  }, [active, kind, containerRef, initialFocusRef]);
}
