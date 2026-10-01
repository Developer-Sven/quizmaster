import { createContext } from "react";

/**
 * Wie die Bühne ihre Overlays anordnet (game-screen.tsx, OverlayFrame):
 * - `stage`: Overlays liegen absolut auf der Bühne zwischen den Streifen und scrollen selbst (Standard).
 * - `flow`: niedrige Viewports (Querformat, 200–400 % Zoom, großer Text) – der ganze Spielscreen scrollt als
 *   ein Dokument; das aktuelle Overlay steht im Fluss, ein ausblendendes liegt nur noch darüber (WCAG 1.4.10).
 *
 * Eigenes kleines Modul, damit der Spielscreen den Rahmen der Overlays nicht ins Haupt-Bundle zieht.
 */
export type OverlayLayout = "stage" | "flow";

export const OverlayLayoutContext = createContext<OverlayLayout>("stage");
