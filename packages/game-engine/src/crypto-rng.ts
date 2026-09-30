/**
 * Subpath „@quizmaster/game-engine/crypto-rng“ – SERVER-ONLY: RNG auf Basis von `node:crypto` randomInt
 * für Produktion (docs/05 §Fairness: Mischung, Kategorien-Angebot und Reihenfolge mit `crypto.randomInt`).
 * Liegt getrennt vom Haupt-Export, damit dieser ohne `node:`-Importe auskommt.
 */
import { randomInt } from "node:crypto";
import { assertRngRange, type Rng } from "./rng.ts";

/** Kryptografisch sicherer RNG (CSPRNG) für den Realtime-Server. */
export function createCryptoRng(): Rng {
  return {
    int(maxExclusive: number): number {
      assertRngRange(maxExclusive);
      return randomInt(maxExclusive);
    },
  };
}
