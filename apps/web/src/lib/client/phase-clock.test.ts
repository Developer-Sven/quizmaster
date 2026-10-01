import { type PublicQuestion, TIMINGS } from "@quizmaster/shared";
import { describe, expect, it } from "vitest";
import {
  ANSWER_REVEAL_EXIT_BEFORE_END_MS,
  CATEGORY_REVEAL_EXIT_BEFORE_START_MS,
  elapsedMs,
  formatCountdown,
  INTRO_TIMELINE,
  inferTimingMode,
  introStage,
  pickHighlightIndex,
  reconnectGraceMs,
  remainingMs,
  stageAt,
  stageBoundaries,
  toClientTime,
  toServerTime,
} from "./phase-clock";

function question(index: number, startsAt: number, answerMs = 20_000): PublicQuestion {
  return {
    id: `q${index}`,
    index,
    total: 3,
    categoryId: "musik-hits",
    prompt: "Frage?",
    answers: ["A", "B", "C", "D"],
    media: null,
    startsAt,
    deadline: startsAt + answerMs,
    answeredBy: [],
  };
}

describe("Serverzeit", () => {
  it("rechnet mit dem Offset zwischen Client- und Serverzeit", () => {
    expect(toServerTime(1_000, 250)).toBe(1_250);
    expect(toServerTime(1_000, -400)).toBe(600);
    expect(toClientTime(1_250, 250)).toBe(1_000);
  });

  it("liefert Restzeit und vergangene Zeit ohne negative Werte", () => {
    expect(remainingMs(10_000, 4_000)).toBe(6_000);
    expect(remainingMs(10_000, 12_000)).toBe(0);
    expect(remainingMs(null, 12_000)).toBeNull();
    expect(elapsedMs(4_000, 10_000)).toBe(6_000);
    expect(elapsedMs(10_000, 4_000)).toBe(0);
  });
});

describe("stageAt", () => {
  it("ordnet jeder Phase ihr Overlay zu", () => {
    expect(stageAt({ phase: "lobby", question: null }, 0)).toBe("none");
    expect(stageAt({ phase: "intro", question: null }, 0)).toBe("intro");
    expect(stageAt({ phase: "category_pick", question: null }, 0)).toBe("category_pick");
    expect(stageAt({ phase: "reveal", question: question(1, 0) }, 0)).toBe("answer_reveal");
    expect(stageAt({ phase: "turn_summary", question: null }, 0)).toBe("turn_summary");
    expect(stageAt({ phase: "round_board", question: null }, 0)).toBe("round_board");
    expect(stageAt({ phase: "game_over", question: null }, 0)).toBe("game_over");
  });

  it("zeigt vor der ersten Frage eines Zuges die Kategorie-Einblendung, danach die Frage ab startsAt", () => {
    const first = { phase: "question" as const, question: question(1, 10_000) };
    expect(stageAt(first, 8_000)).toBe("category_reveal");
    expect(stageAt(first, 9_999)).toBe("category_reveal");
    expect(stageAt(first, 10_000)).toBe("question");
    expect(stageBoundaries(first)).toEqual([10_000]);
  });

  it("zeigt vor weiteren Fragen eine kurze Pause (Vorlauf 800 ms)", () => {
    const next = { phase: "question" as const, question: question(2, 10_000) };
    expect(stageAt(next, 9_500)).toBe("lead_in");
    expect(stageAt(next, 10_001)).toBe("question");
    expect(stageAt({ phase: "question", question: null }, 0)).toBe("lead_in");
  });

  it("hat außerhalb der Frage keine Zwischenzeitpunkte", () => {
    expect(stageBoundaries({ phase: "reveal", question: question(1, 5) })).toEqual([]);
  });
});

describe("Choreografie-Zeitpunkte (docs/09 §7)", () => {
  it("Intro: Avatare, ab 3.500 ms Titelkarte, ab 4.600 ms Ausblenden", () => {
    expect(INTRO_TIMELINE).toEqual({ scrimMs: 480, titleAtMs: 3_500, exitAtMs: 4_600 });
    expect(introStage(0)).toBe("people");
    expect(introStage(3_499)).toBe("people");
    expect(introStage(3_500)).toBe("title");
    expect(introStage(4_599)).toBe("title");
    expect(introStage(4_600)).toBe("done");
  });

  it("Kategorie-Einblendung endet bei 2.400 von 3.000 ms, die Auflösung 500 ms vor ihrem Ende (ADR-044/045)", () => {
    expect(TIMINGS.normal.leadInFirstQuestionMs - CATEGORY_REVEAL_EXIT_BEFORE_START_MS).toBe(2_400);
    expect(ANSWER_REVEAL_EXIT_BEFORE_END_MS).toBe(500);
  });

  it("der wandernde Rahmen springt im 1,2-s-Takt über die drei Kacheln", () => {
    expect(pickHighlightIndex(0)).toBe(0);
    expect(pickHighlightIndex(1_199)).toBe(0);
    expect(pickHighlightIndex(1_200)).toBe(1);
    expect(pickHighlightIndex(3_600)).toBe(0);
    expect(pickHighlightIndex(-50)).toBe(0);
  });
});

describe("inferTimingMode", () => {
  const phaseState = (phase: "intro" | "category_pick" | "reveal" | "turn_summary" | "round_board", ms: number) => ({
    phase,
    phaseStartedAt: 1_000,
    phaseEndsAt: 1_000 + ms,
    question: null,
  });

  it("erkennt normal und fast an Phasen mit fester Dauer", () => {
    expect(inferTimingMode(phaseState("intro", 5_000))).toBe("normal");
    expect(inferTimingMode(phaseState("intro", 300))).toBe("fast");
    expect(inferTimingMode(phaseState("category_pick", 15_000))).toBe("normal");
    expect(inferTimingMode(phaseState("category_pick", 1_500))).toBe("fast");
    // Weiter-Phasen sind einstellbar (ADR-045) – ihre Dauer sagt nichts über den Modus.
    expect(inferTimingMode(phaseState("reveal", 5_000))).toBeNull();
    expect(inferTimingMode(phaseState("turn_summary", 300))).toBeNull();
    expect(inferTimingMode(phaseState("round_board", 7_000))).toBeNull();
  });

  it("erkennt die Frage an der Antwortzeit (auch nach früher Auflösung)", () => {
    expect(
      inferTimingMode({ phase: "question", phaseStartedAt: 0, phaseEndsAt: 5_000, question: question(1, 800, 20_000) }),
    ).toBe("normal");
    expect(
      inferTimingMode({ phase: "question", phaseStartedAt: 0, phaseEndsAt: 400, question: question(1, 100, 2_000) }),
    ).toBe("fast");
  });

  it("liefert null ohne feste Dauer oder bei unbekannter Dauer", () => {
    expect(inferTimingMode({ phase: "lobby", phaseStartedAt: 0, phaseEndsAt: null, question: null })).toBeNull();
    expect(inferTimingMode({ phase: "game_over", phaseStartedAt: 0, phaseEndsAt: null, question: null })).toBeNull();
    expect(inferTimingMode(phaseState("intro", 1_234))).toBeNull();
  });
});

describe("Reconnect-Frist und Countdown", () => {
  it("hält den Platz 30 s in der Lobby und 90 s im Spiel (docs/05)", () => {
    expect(reconnectGraceMs("lobby", "normal")).toBe(30_000);
    expect(reconnectGraceMs("question", "normal")).toBe(90_000);
    expect(reconnectGraceMs("game_over", "normal")).toBe(90_000);
    expect(reconnectGraceMs("lobby", "fast")).toBe(2_000);
    expect(reconnectGraceMs("intro", "fast")).toBe(5_000);
  });

  it("formatiert m:ss mit aufgerundeten Sekunden", () => {
    expect(formatCountdown(90_000)).toBe("1:30");
    expect(formatCountdown(89_001)).toBe("1:30");
    expect(formatCountdown(59_001)).toBe("1:00");
    expect(formatCountdown(4_200)).toBe("0:05");
    expect(formatCountdown(0)).toBe("0:00");
    expect(formatCountdown(-500)).toBe("0:00");
    expect(formatCountdown(Number.NaN)).toBe("0:00");
  });
});
