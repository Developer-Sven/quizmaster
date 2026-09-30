import { cx } from "../../lib/ui/cx";

/** Form des Platzhalters – Radien aus den Tokens. */
export type SkeletonShape = "text" | "block" | "answer" | "tile" | "card" | "avatar";

const shapeClasses: Record<SkeletonShape, string> = {
  /** Textzeile */
  text: "h-4 w-full rounded-sm",
  /** Button, Eingabe, Listenzeile (56) */
  block: "h-14 w-full rounded-lg",
  /** Antwort (64) */
  answer: "h-16 w-full rounded-lg",
  /** Kategorie-Kachel (88) */
  tile: "h-22 w-full rounded-lg",
  /** Karte (z. B. Fragekarte) */
  card: "h-40 w-full rounded-xl",
  /** Avatar 40 */
  avatar: "size-10 rounded-full",
};

export interface SkeletonProps {
  shape?: SkeletonShape;
}

/**
 * Skeleton (docs/09 §5): Fläche in `surface-2` mit 1,2-s-Deckkraft-Puls (ohne Puls bei reduzierter
 * Bewegung). Rein dekorativ – den Ladezustand für Screenreader am Container angeben
 * (`aria-busy` + Text „Lädt …“).
 */
export function Skeleton({ shape = "block" }: SkeletonProps) {
  return (
    <span
      aria-hidden="true"
      className={cx("block animate-pulse bg-surface-2 motion-reduce:animate-none", shapeClasses[shape])}
    />
  );
}
