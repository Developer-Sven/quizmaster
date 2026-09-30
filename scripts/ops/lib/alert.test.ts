import { describe, expect, it } from "vitest";
import { alertPayload } from "./alert.ts";

describe("alertPayload", () => {
  it("Discord (content) und Slack (text) bekommen denselben Text mit Absender", () => {
    expect(alertPayload("Testalarm von quizmaster", "srv1")).toEqual({
      content: "quizmaster (srv1): Testalarm von quizmaster",
      text: "quizmaster (srv1): Testalarm von quizmaster",
    });
  });

  it("entschärft Massen-Erwähnungen, fasst Leerraum zusammen und kürzt auf Discord-Länge", () => {
    const payload = alertPayload("@everyone  Backup\n  fehlgeschlagen @here", "h");
    expect(payload.content).toBe("quizmaster (h): (at)everyone Backup fehlgeschlagen (at)here");
    expect(alertPayload("x".repeat(5000), "h").content).toHaveLength(1900);
  });
});
