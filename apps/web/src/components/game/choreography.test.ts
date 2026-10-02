import { TIMINGS } from "@quizmaster/shared";
import { describe, expect, it } from "vitest";
import { INTRO_TIMELINE, introStage, stageAt } from "../../lib/client/phase-clock";
import { testLobby, testPlayer, testQuestion } from "../../lib/client/test-support";
import { DURATION_MS, EASING } from "../../lib/ui/tokens";
import {
  CHOREOGRAPHY,
  type CueSchedulerDeps,
  categoryRevealLeaveAt,
  createCueScheduler,
  cueAction,
  displayedScores,
  enterMotion,
  entranceDone,
  flightPath,
  momentAhead,
  motionPlan,
  overlayLeaveAt,
  pickHighlight,
  pointsShown,
  REDUCED_FADE_MS,
  remainingDelayMs,
  revealGains,
  type StageCue,
  scoreBoundaries,
  stageCues,
  stageTransition,
  wanderBoundaries,
} from "./choreography";

const AVATAR = { at: 480, duration: 320, from: { opacity: 0, y: 24 } } as const;

describe("Einblendungen relativ zum Anker (docs/09 §7–8)", () => {
  it("startet künftige Bewegungen pünktlich (Verzögerung = Zeitpunkt − Einstieg)", () => {
    const motion = enterMotion(AVATAR, 0, false);
    expect(motion.initial).toEqual({ opacity: 0, y: 24 });
    expect(motion.animate).toEqual({ opacity: 1, y: 0 });
    expect(motion.transition).toEqual({ duration: 0.32, ease: EASING.emphasized, delay: 0.48 });
    // Einstieg 100 ms nach dem Anker (Netzlatenz): Start trotzdem bei 480 ms Serverzeit
    expect(enterMotion(AVATAR, 100, false).transition.delay).toBeCloseTo(0.38);
  });

  it("setzt laufende Bewegungen nach einem Reconnect mittendrin fort (negative Verzögerung)", () => {
    const motion = enterMotion(AVATAR, 600, false);
    expect(motion.initial).toEqual({ opacity: 0, y: 24 });
    expect(motion.transition.delay).toBeCloseTo(-0.12);
  });

  it("zeigt abgeschlossene Bewegungen sofort im Endzustand – nichts wird wiederholt", () => {
    const motion = enterMotion(AVATAR, 800, false);
    expect(motion.initial).toBe(false);
    expect(motion.animate).toEqual({ opacity: 1, y: 0 });
    expect(entranceDone(480, 320, 800)).toBe(true);
    expect(entranceDone(480, 320, 799)).toBe(false);
  });

  it("liefert für Bausteine mit eigener Verzögerung die Restzeit bzw. `undefined`, wenn schon gefüllt", () => {
    expect(remainingDelayMs(320, 200, 0)).toBe(320);
    expect(remainingDelayMs(320, 200, 400)).toBe(0);
    expect(remainingDelayMs(320, 200, 520)).toBeUndefined();
  });

  it("erkennt, ob ein Moment beim Einstieg noch bevorstand (Ruck, Pop, Flug)", () => {
    expect(momentAhead(0, 80, 120)).toBe(true);
    expect(momentAhead(0, 121, 120)).toBe(false);
    expect(momentAhead(200, 200, 0)).toBe(true);
    expect(momentAhead(200, 201, 0)).toBe(false);
  });
});

describe("Bewegungsreduktion (prefers-reduced-motion)", () => {
  it("macht jede Bewegung zur Überblendung von höchstens 200 ms", () => {
    for (const spec of [
      AVATAR,
      { at: 0, duration: DURATION_MS.overlay, from: { opacity: 0, scale: 0.96 } },
      { at: 40, duration: DURATION_MS.slow, from: { opacity: 0, x: -24 } },
      { at: 0, duration: DURATION_MS.slow, from: { y: 48 } },
    ]) {
      const motion = enterMotion(spec, 0, true);
      expect(motion.initial).toEqual({ opacity: 0 });
      expect(motion.animate).toEqual({ opacity: 1 });
      expect(motion.transition.duration).toBeLessThanOrEqual(0.2);
      expect(motion.transition.ease).toEqual(EASING.standard);
    }
    expect(REDUCED_FADE_MS).toBe(200);
  });

  it("schaltet Ruck, Pops, wandernden Rahmen, Flug und Podest-Wachstum ab – Timer bleiben (nicht Teil des Plans)", () => {
    expect(motionPlan(true)).toEqual({
      wander: false,
      shake: false,
      crownPop: false,
      flight: false,
      podiumGrowth: false,
      maxMotionMs: 200,
    });
    const full = motionPlan(false);
    expect([full.wander, full.shake, full.crownPop, full.flight, full.podiumGrowth]).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
  });
});

describe("Overlay-Phasen aus der Serverzeit", () => {
  const start = 100_000;

  const ended = (phaseEndsAt: number | null) => ({ phaseStartedAt: start, phaseEndsAt, question: null });

  it("folgt dem Intro (5 s, ADR-044): Personen, Titelkarte ab 3.500 ms, Ausblenden ab 4.600 ms", () => {
    expect(introStage(0)).toBe("people");
    expect(introStage(3_499)).toBe("people");
    expect(introStage(3_500)).toBe("title");
    expect(introStage(4_600)).toBe("done");
    expect(overlayLeaveAt("intro", ended(start + 5_000))).toBe(start + INTRO_TIMELINE.exitAtMs);
    expect(CHOREOGRAPHY.intro.avatarsAtMs).toBe(480);
    expect(CHOREOGRAPHY.intro.avatarStaggerMs).toBe(150);
  });

  it("blendet die Kategorie nach 2.400 von 3.000 ms Vorlauf aus (im schnellen Modus anteilig)", () => {
    expect(categoryRevealLeaveAt(start, start + TIMINGS.normal.leadInFirstQuestionMs)).toBe(start + 2_400);
    expect(categoryRevealLeaveAt(start, start + TIMINGS.fast.leadInFirstQuestionMs)).toBe(start + 120);
    const state = { phaseStartedAt: start, phaseEndsAt: null, question: testQuestion({ startsAt: start + 3_000 }) };
    expect(overlayLeaveAt("category_reveal", state)).toBe(start + 2_400);
    expect(overlayLeaveAt("category_reveal", ended(null))).toBeNull();
  });

  it("blendet die Auflösung 500 ms vor ihrem Ende aus – nicht, wenn sie auf den Host wartet (ADR-045)", () => {
    expect(overlayLeaveAt("answer_reveal", ended(start + 5_000))).toBe(start + 4_500);
    expect(overlayLeaveAt("answer_reveal", ended(start + 15_000))).toBe(start + 14_500);
    expect(overlayLeaveAt("answer_reveal", ended(null))).toBeNull();
    // Schneller Testmodus (300 ms): kein vorzeitiges Ausblenden, die Phase endet vorher.
    expect(overlayLeaveAt("answer_reveal", ended(start + 300))).toBeNull();
    for (const kind of ["category_pick", "question", "turn_summary", "round_board", "game_over"] as const) {
      expect(overlayLeaveAt(kind, ended(start + 5_000))).toBeNull();
    }
  });

  it("wechselt von der Frage in die Auflösung ohne Aus-/Einblenden („cut“)", () => {
    expect(stageTransition("answer_reveal")).toBe("cut");
    for (const kind of ["intro", "category_pick", "category_reveal", "question", "turn_summary"] as const) {
      expect(stageTransition(kind)).toBe("fade");
    }
  });

  it("zeigt nach einem Reconnect sofort die Stufe, die gerade läuft", () => {
    const question = testQuestion({ index: 1, startsAt: start + 2_000, deadline: start + 22_000 });
    const state = { phase: "question" as const, question };
    expect(stageAt(state, start + 500)).toBe("category_reveal");
    expect(stageAt(state, start + 2_000)).toBe("question");
    // Einstieg mitten in der Frage: Karte und Antworten stehen sofort (keine Wiederholung der Einblendung)
    const enteredAt = start + 9_000 - question.startsAt;
    expect(enterMotion({ at: 0, duration: 200, from: { opacity: 0, y: 16 } }, enteredAt, false).initial).toBe(false);
  });
});

describe("Wandernder Rahmen der Kategoriewahl", () => {
  const start = 50_000;

  it("wandert im 1,2-s-Takt ab Phasenbeginn – für alle Geräte gleich, unabhängig vom Einstieg", () => {
    expect(pickHighlight(start, start + 100)).toEqual({ index: 0, nextAt: start + 1_200 });
    expect(pickHighlight(start, start + 1_200)).toEqual({ index: 1, nextAt: start + 2_400 });
    expect(pickHighlight(start, start + 2_500)).toEqual({ index: 2, nextAt: start + 3_600 });
    expect(pickHighlight(start, start + 3_600).index).toBe(0);
  });

  it("plant alle Wechsel innerhalb der Wahl (15 s) und nicht darüber hinaus", () => {
    const times = wanderBoundaries(start, start + TIMINGS.normal.categoryPickMs);
    expect(times[0]).toBe(start + 1_200);
    expect(times.at(-1)).toBe(start + 14_400);
    expect(times).toHaveLength(12);
    expect(wanderBoundaries(start, start + TIMINGS.fast.categoryPickMs)).toEqual([start + 1_200]);
  });
});

describe("Punkte: „+1“ ab 1.200 ms der Auflösung", () => {
  const players = [testPlayer("p1", { score: 3 }), testPlayer("p2", { score: 5 }), testPlayer("p3", { score: 1 })];
  const reveal = testLobby({
    phase: "reveal",
    phaseStartedAt: 10_000,
    players,
    question: testQuestion({ correct: 1, picks: { p1: 1, p2: 0, p3: null } }),
  });

  it("kennt die Gewinne nur aus der Auflösung", () => {
    expect([...revealGains(reveal)]).toEqual([["p1", 1]]);
    expect(revealGains({ ...reveal, phase: "question" }).size).toBe(0);
  });

  it("zeigt bis 1.200 ms den alten Stand, danach den neuen", () => {
    expect(pointsShown(reveal, 11_199)).toBe(false);
    expect(pointsShown(reveal, 11_200)).toBe(true);
    expect(displayedScores(reveal, false)).toEqual({ p1: 2, p2: 5, p3: 1 });
    expect(displayedScores(reveal, true)).toEqual({ p1: 3, p2: 5, p3: 1 });
    expect(scoreBoundaries(reveal)).toEqual([11_200]);
  });

  it("zeigt außerhalb der Auflösung immer den Serverstand", () => {
    const summary = { ...reveal, phase: "turn_summary" as const };
    expect(pointsShown(summary, 0)).toBe(true);
    expect(displayedScores(summary, true)).toEqual({ p1: 3, p2: 5, p3: 1 });
    expect(scoreBoundaries(summary)).toEqual([]);
  });
});

describe("Cues: Töne und Haptik (docs/09 §7, §10)", () => {
  const question = testQuestion({ id: "q7", index: 1, startsAt: 12_000, deadline: 32_000 });

  it("spielt `turn` zur Kategorie-Einblendung und `tick` je Sekunde in den letzten 5 s", () => {
    const cues = stageCues(testLobby({ phase: "question", phaseStartedAt: 10_000, question }), "p1");
    expect(cues.map((cue) => [cue.id, cue.at, cue.sound])).toEqual([
      ["pick:q7", 10_000, "turn"],
      ["tick:q7:5", 27_000, "tick"],
      ["tick:q7:4", 28_000, "tick"],
      ["tick:q7:3", 29_000, "tick"],
      ["tick:q7:2", 30_000, "tick"],
      ["tick:q7:1", 31_000, "tick"],
    ]);
  });

  it("ohne Countdown („Zeit pro Frage: Host“, ADR-049) tickt nichts", () => {
    const question = testQuestion({ index: 2, startsAt: 10_000, deadline: 10_000 + 600_000 });
    const state = { phase: "question" as const, phaseStartedAt: 9_000, question, results: null };
    expect(stageCues({ ...state, settings: { answerSec: 0 } }, "p1").filter((cue) => cue.sound === "tick")).toEqual([]);
    expect(
      stageCues({ ...state, settings: { answerSec: 20 } }, "p1").filter((cue) => cue.sound === "tick"),
    ).toHaveLength(5);
  });

  it("tickt bei weiteren Fragen ohne `turn` und nie vor `startsAt` (schneller Modus: 2 s Antwortzeit)", () => {
    const fast = testQuestion({ id: "q8", index: 2, startsAt: 1_000, deadline: 3_000 });
    const cues = stageCues(testLobby({ phase: "question", phaseStartedAt: 900, question: fast }), "p1");
    expect(cues.map((cue) => cue.id)).toEqual(["tick:q8:2", "tick:q8:1"]);
  });

  it("spielt die eigene Auflösung: richtig [20, 40, 20], falsch und keine Antwort 60 ms", () => {
    const resolved = testQuestion({ id: "q9", correct: 2, picks: { p1: 2, p2: 0, p3: null } });
    const state = testLobby({ phase: "reveal", phaseStartedAt: 40_000, question: resolved });
    expect(stageCues(state, "p1")).toEqual([
      { id: "result:q9", at: 40_000, sound: "correct", haptic: "correct", lateMs: 1_000 },
    ]);
    expect(stageCues(state, "p2")[0]).toMatchObject({ sound: "wrong", haptic: "wrong" });
    expect(stageCues(state, "p3")[0]).toMatchObject({ sound: "wrong", haptic: "wrong" });
    // Zuschauende ohne Teilnahme an der Frage hören nichts
    expect(stageCues(state, "p4")).toEqual([]);
    expect(stageCues(state, null)).toEqual([]);
  });

  it("spielt am Spielende `win`, `lose` bzw. `turn` bei Unentschieden", () => {
    const results = (outcome: "win" | "draw") => ({
      outcome,
      ranking: [
        { playerId: "p1", place: 1, score: 7, status: "active" as const },
        {
          playerId: "p2",
          place: outcome === "draw" ? 1 : 2,
          score: outcome === "draw" ? 7 : 5,
          status: "active" as const,
        },
      ],
    });
    const end = (outcome: "win" | "draw") =>
      testLobby({ phase: "game_over", phaseStartedAt: 90_000, results: results(outcome) });
    expect(stageCues(end("win"), "p1")).toEqual([
      { id: "end:90000", at: 90_000, sound: "win", haptic: null, lateMs: 1_000 },
    ]);
    expect(stageCues(end("win"), "p2")[0]?.sound).toBe("lose");
    expect(stageCues(end("draw"), "p2")[0]?.sound).toBe("turn");
    expect(stageCues(end("win"), "p9")).toEqual([]);
  });

  it("entscheidet je Cue: feuern, warten oder (gefeuert bzw. zu spät) entfallen", () => {
    const cue: StageCue = { id: "tick:q:3", at: 1_000, sound: "tick", haptic: null, lateMs: 250 };
    expect(cueAction(cue, 900, new Set())).toEqual({ kind: "wait", inMs: 100 });
    expect(cueAction(cue, 1_000, new Set())).toEqual({ kind: "fire" });
    expect(cueAction(cue, 1_250, new Set())).toEqual({ kind: "fire" });
    expect(cueAction(cue, 1_251, new Set())).toEqual({ kind: "skip" });
    expect(cueAction(cue, 1_000, new Set(["tick:q:3"]))).toEqual({ kind: "skip" });
  });
});

/** Planer mit manueller Zeit und Timern (ohne echte Uhr). */
function manualScheduler() {
  let now = 0;
  let nextHandle = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const played: string[] = [];
  const deps: CueSchedulerDeps = {
    setTimer: (callback, ms) => {
      const handle = nextHandle++;
      timers.set(handle, { at: now + ms, callback });
      return handle;
    },
    clearTimer: (handle) => {
      timers.delete(handle);
    },
    run: (cue) => played.push(cue.id),
  };
  const scheduler = createCueScheduler(deps);
  return {
    scheduler,
    played,
    clock: () => now,
    /** Zeit vorrücken und fällige Timer ausführen */
    advance(to: number) {
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= to).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].callback();
      }
      now = to;
    },
    pending: () => timers.size,
  };
}

describe("Cue-Planer: Fortsetzen nach Reconnect ohne Doppel", () => {
  const tick = (seconds: number): StageCue => ({
    id: `tick:q:${seconds}`,
    at: 10_000 - seconds * 1_000,
    sound: "tick",
    haptic: null,
    lateMs: 250,
  });
  const cues = [tick(5), tick(4), tick(3), tick(2), tick(1)];

  it("feuert jeden Cue zu seiner Serverzeit genau einmal", () => {
    const run = manualScheduler();
    run.scheduler.schedule(cues, run.clock);
    run.advance(5_500);
    expect(run.played).toEqual(["tick:q:5"]);
    run.advance(10_000);
    expect(run.played).toEqual(["tick:q:5", "tick:q:4", "tick:q:3", "tick:q:2", "tick:q:1"]);
  });

  it("plant nach einem Reconnect neu: Gehörtes kommt nicht doppelt, Verpasstes nicht verspätet", () => {
    const run = manualScheduler();
    const cancel = run.scheduler.schedule(cues, run.clock);
    run.advance(6_100); // tick 5 und 4 gespielt
    cancel(); // Verbindung weg (Komponente plant neu)
    run.advance(7_600); // tick 3 (7.000) verpasst – mehr als 250 ms zu spät
    run.scheduler.schedule(cues, run.clock);
    run.advance(10_000);
    expect(run.played).toEqual(["tick:q:5", "tick:q:4", "tick:q:2", "tick:q:1"]);
    expect(run.scheduler.fired.has("tick:q:3")).toBe(true);
  });

  it("holt einen knapp verpassten Cue innerhalb der Toleranz nach und bricht Timer beim Abmelden ab", () => {
    const run = manualScheduler();
    run.advance(5_100);
    const cancel = run.scheduler.schedule(cues, run.clock);
    expect(run.played).toEqual(["tick:q:5"]);
    expect(run.pending()).toBe(4);
    cancel();
    expect(run.pending()).toBe(0);
  });

  it("wartet erneut, wenn ein Timer zu früh feuert (Uhrenabgleich zwischen Planen und Feuern)", () => {
    const run = manualScheduler();
    const cue: StageCue = { id: "end:1", at: 1_000, sound: "win", haptic: null, lateMs: 1_000 };
    let skew = 3;
    run.scheduler.schedule([cue], () => run.clock() - skew);
    // Der Offset ändert sich: beim Timer (Client 1.003) ist es auf dem Server erst 998
    skew = 5;
    run.advance(1_003);
    expect(run.played).toEqual([]);
    run.advance(1_010);
    expect(run.played).toEqual(["end:1"]);
  });
});

describe("Flug der Kachel in den Kategoriestreifen (FLIP, nur transform/opacity)", () => {
  it("startet über der Kachel und landet linksbündig, mittig und gleichmäßig verkleinert im Streifen", () => {
    const tile = { left: 16, top: 300, width: 328, height: 88 };
    const strip = { left: 16, top: 56, width: 328, height: 44 };
    expect(flightPath(tile, strip, 16)).toEqual({
      from: { x: 0, y: 300 },
      to: { x: 0, y: 56, scale: 0.5 },
    });
  });

  it("berücksichtigt einen Versatz der Bühne (Scrollleiste) und begrenzt den Maßstab", () => {
    const path = flightPath(
      { left: 24, top: 200, width: 320, height: 88 },
      { left: 16, top: 60, width: 320, height: 10 },
      16,
    );
    expect(path.from.x).toBe(8);
    expect(path.to.scale).toBe(0.3);
    expect(path.to.y).toBeCloseTo(60 + (10 - 88 * 0.3) / 2);
  });
});
