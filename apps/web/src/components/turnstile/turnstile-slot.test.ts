/**
 * TurnstileSlot (docs/06 §Bot-Schutz, docs/09 §11): Die Prüfung zeigt ihre eigenen Fehler (Status `error`). Lehnt der
 * Server das Token einer BESTANDENEN Prüfung ab (falscher Schlüssel, fremder Hostname, Wiederholung), steht sie
 * wieder auf `idle` – dann muss `rejected` den Fehler sichtbar machen (Lobby-Seite: Panel über dem
 * Verbindungs-Overlay mit „Erneut versuchen“), sonst bleibt die Seite ohne Erklärung stehen.
 * Serverseitig gerendert: `useSyncExternalStore` liefert dort den Status `idle`.
 */
import { describe, expect, it } from "vitest";
import { de } from "../../i18n/de";
import { createTurnstileSolver } from "../../lib/client/turnstile";
import { renderHtml } from "../ui/ssr-render";
import { TurnstileSlot } from "./turnstile-slot";

const solver = createTurnstileSolver({ siteKey: "1x00000000000000000000AA", load: () => new Promise(() => undefined) });
const retry = () => undefined;

describe("TurnstileSlot", () => {
  it("ohne Prüfung (kein Site Key) rendert nichts", () => {
    expect(renderHtml(TurnstileSlot, { solver: null, rejected: true })).toBe("");
  });

  it("Prüfung ruht, nichts abgelehnt: kein Fehler, Panel ohne Fläche und ohne Knopf", () => {
    expect(renderHtml(TurnstileSlot, { solver })).not.toContain(de.turnstile.failed);
    const panel = renderHtml(TurnstileSlot, { solver, variant: "panel", onRetry: retry });
    expect(panel).not.toContain(de.turnstile.failed);
    expect(panel).not.toContain(de.turnstile.retry);
    expect(panel).toContain("pointer-events-none");
  });

  it("Server lehnte das Token der bestandenen Prüfung ab: Fehler sichtbar, im Panel mit „Erneut versuchen“", () => {
    const inline = renderHtml(TurnstileSlot, { solver, rejected: true });
    expect(inline).toContain('data-state="idle"');
    expect(inline).toContain(de.turnstile.failed);

    const panel = renderHtml(TurnstileSlot, { solver, variant: "panel", rejected: true, onRetry: retry });
    expect(panel).toContain(de.turnstile.failed);
    expect(panel).toContain(de.turnstile.retry);
    expect(panel).not.toContain("pointer-events-none");
  });
});
