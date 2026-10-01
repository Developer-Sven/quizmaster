import { describe, expect, it } from "vitest";
import { COMPACT_HEIGHT_REM, isCompactHeight } from "./use-choreography";

describe("Niedriger Viewport (WCAG 1.4.10): Spielscreen scrollt als ein Dokument", () => {
  it("bleibt bei den Referenz-Viewports (360 × 740, 430 × 932, iPhone 15) bei der Bühne", () => {
    expect(isCompactHeight(740, 16)).toBe(false);
    expect(isCompactHeight(932, 16)).toBe(false);
    expect(isCompactHeight(659, 16)).toBe(false);
    expect(isCompactHeight(640, 16)).toBe(false);
  });

  it("greift bei Querformat und Zoom (weniger CSS-Pixel) ebenso wie bei großer Schrift (größere rem)", () => {
    expect(isCompactHeight(360, 16)).toBe(true); // 1280 × 720 bei 200 % bzw. Handy quer
    expect(isCompactHeight(256, 16)).toBe(true); // 1280 × 1024 bei 400 %
    expect(isCompactHeight(568, 32)).toBe(true); // 320 × 568 mit 200 % Schrift
    expect(isCompactHeight(740, 24)).toBe(true); // 360 × 740 mit 150 % Schrift
    expect(isCompactHeight(COMPACT_HEIGHT_REM * 16, 16)).toBe(true);
  });

  it("rechnet ohne lesbare Schriftgröße mit 16 px", () => {
    expect(isCompactHeight(500, Number.NaN)).toBe(true);
    expect(isCompactHeight(740, 0)).toBe(false);
  });
});
