import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OfflineRetryButton, retryTarget } from "./offline-retry-button";

describe("Offline-Seite: „Erneut versuchen“ (docs/10)", () => {
  it("lädt die ursprünglich aufgerufene Adresse neu (der SW zeigt die Offline-Seite unter ihr)", () => {
    expect(retryTarget("/lobby/ABC234")).toBe("reload");
    expect(retryTarget("/j/ABC234")).toBe("reload");
    expect(retryTarget("/")).toBe("reload");
  });

  it("führt von /offline selbst zur Startseite", () => {
    expect(retryTarget("/offline")).toBe("start");
  });

  it("ist der eine primäre Button der Seite mit dem Text aus docs/09 §11", () => {
    const html = renderToStaticMarkup(createElement(OfflineRetryButton));
    expect(html).toMatch(/^<button[^>]*data-testid="offline-retry"/);
    expect(html).toContain("bg-primary");
    expect(html).toContain("Erneut versuchen");
  });
});
