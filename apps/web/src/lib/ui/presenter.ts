"use client";

import { useEffect } from "react";

/**
 * Anzeige-Modus (ADR-046): Der Host spielt nicht mit, sein Gerät (PC, Fernseher) zeigt Frage und Antworten groß.
 * Solange `active`, trägt `<html>` das Attribut `data-presenter`; globals.css vergrößert dann auf großen
 * Bildschirmen alles gleichmäßig (`zoom` nach Fensterhöhe) – auf Handys bleibt alles, wie es ist.
 */
export function usePresenterZoom(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const root = document.documentElement;
    root.dataset.presenter = "";
    return () => {
      delete root.dataset.presenter;
    };
  }, [active]);
}
