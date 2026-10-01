import { describe, expect, it } from "vitest";
import { PREVIEW_CATALOG, PREVIEW_VIEWS, type PreviewContext } from "./sample-states";

const ctx: PreviewContext = { now: 1_800_000_000_000, count: 2 };

describe("Vorschau-Zustände (/dev/game, Manifest-Screenshots)", () => {
  it("stellt jede Beispielfrage in einer passenden Kategorie – frage.png zeigt keine Hauptstadt unter „Bücher & Wörter“", () => {
    for (const view of [
      "question",
      "question-locked",
      "question-long",
      "question-flag",
      "category-reveal",
      "answer-correct",
    ] as const) {
      const scene = PREVIEW_VIEWS[view].build(ctx);
      if (scene.kind !== "game") throw new Error(`${view}: keine Spielszene`);
      const { question, turn } = scene.lobby;
      expect(question?.categoryId, view).toBe("rund-um-die-welt");
      expect(turn?.categoryId, view).toBe(question?.categoryId);
      expect(
        turn?.options.map((option) => option.id),
        view,
      ).toContain(question?.categoryId);
    }
    expect(PREVIEW_CATALOG["rund-um-die-welt"]?.name).toBe("Rund um die Welt");
  });

  it("ordnet auch „Fragen ansehen“ die Beispielfragen ihrer Kategorie zu", () => {
    const scene = PREVIEW_VIEWS.review.build(ctx);
    if (scene.kind !== "game") throw new Error("keine Spielszene");
    expect(scene.review?.items.map((item) => item.categoryId)).toEqual([
      "rund-um-die-welt",
      "rund-um-die-welt",
      "rund-um-die-welt",
    ]);
  });
});
