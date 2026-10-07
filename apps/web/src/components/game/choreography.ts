/**
 * Choreografie der Bühne (docs/09 §7–8, ADR-020) als reine Funktionen über Serverzeitpunkte.
 *
 * Jedes Overlay hat einen **Anker** (Serverzeit): Intro, Kategoriewahl, Auflösung, Zug-Ergebnis, Rundentafel
 * und Spielende `phaseStartedAt`; die Kategorie-Einblendung den Beginn des Vorlaufs (`phaseStartedAt` der
 * Phase `question`); die Frage `startsAt`. Alle Zeitpunkte unten sind Millisekunden relativ zu diesem Anker –
 * dadurch sieht jede Person jeden Moment zur selben Zeit (Uhren-Offset aus docs/05).
 *
 * **Fortsetzen statt Wiederholen (Reconnect, Neuladen):** Ein Overlay merkt sich beim Einhängen, wie weit sein
 * Anker schon zurückliegt (`enteredAt`). Bereits abgeschlossene Bewegungen erscheinen sofort im Endzustand,
 * laufende setzen mitten in der Bewegung ein (negative Verzögerung), künftige starten pünktlich. Töne und
 * Haptik sind „Cues“ mit eindeutiger ID: Jeder Cue feuert höchstens einmal je Seite; ist sein Zeitpunkt beim
 * Planen schon länger als seine Toleranz vorbei, entfällt er (ein verspäteter Ton passt nicht mehr zum Bild).
 *
 * **Bewegungsreduktion:** Mit `prefers-reduced-motion` wird jede Bewegung zur Überblendung von höchstens
 * 200 ms; Ruck, Pops, der wandernde Rahmen, der Flug der Kachel und das Wachsen des Podests entfallen
 * ({@link motionPlan}). Timer laufen weiter (Information).
 */
import type { PublicLobbyState } from "@quizmaster/shared";
import type { HapticKind } from "../../lib/client/haptics";
import {
  ANSWER_REVEAL_EXIT_BEFORE_END_MS,
  INTRO_TIMELINE,
  PICK_HIGHLIGHT_STEP_MS,
  pickHighlightIndex,
  type StageKind,
} from "../../lib/client/phase-clock";
import type { SoundName } from "../../lib/client/sound";
import { DURATION_MS, EASING, OFFSET_PX, STAGGER_MS, seconds } from "../../lib/ui/tokens";
import { ownOutcome } from "./results";

// ---------------------------------------------------------------------------------------------------
// Zeitpunkte (docs/09 §7) und Dauern (docs/09 §8)
// ---------------------------------------------------------------------------------------------------

export const CHOREOGRAPHY = {
  /** 1 · Intro „Anpfiff“ (Phase `intro`, 5 s – Spieltempo ADR-044: alles etwa doppelt so ruhig) */
  intro: {
    /** 0–480 ms Scrim, danach fahren die Avatare ein */
    avatarsAtMs: INTRO_TIMELINE.scrimMs,
    avatarStaggerMs: STAGGER_MS.people,
    avatarRisePx: 24,
    enterMs: DURATION_MS.overlay,
    titleAtMs: INTRO_TIMELINE.titleAtMs,
    titleRisePx: 24,
    exitAtMs: INTRO_TIMELINE.exitAtMs,
  },
  /** 2 · Kategoriewahl (Phase `category_pick`, 15 s) */
  pick: {
    tileStaggerMs: STAGGER_MS.tiles,
    enterMs: DURATION_MS.overlay,
    wanderStepMs: PICK_HIGHLIGHT_STEP_MS,
    fadeOthersMs: DURATION_MS.base,
  },
  /** 3 · Kategorie-Reveal (Vorlauf der ersten Frage eines Zuges, 3 s) */
  categoryReveal: {
    flightMs: DURATION_MS.overlay,
    tileMs: DURATION_MS.overlay,
    tileFromScale: 0.8,
    /** Ausblenden nach 80 % des Vorlaufs (2.400 von 3.000 ms) */
    exitFraction: 0.8,
    /** Der Flug startet nur, wenn die Einblendung höchstens so spät eingehängt wird. */
    flightLateMs: 250,
  },
  /** 4–5 · Frage (ab `startsAt`, 20 s) und Einloggen */
  question: {
    cardMs: DURATION_MS.base,
    cardRisePx: 16,
    answersAtMs: DURATION_MS.base,
    answerStaggerMs: STAGGER_MS.list,
    answerMs: DURATION_MS.base,
    /** Ab dieser Restzeit: Balken rot, Ton `tick` einmal pro Sekunde */
    tickFromMs: 5_000,
  },
  /** 6 · Auflösung (Phase `reveal`, Standard 5 s bzw. Weiter-Einstellung, ADR-045) */
  answerReveal: {
    shakeMs: 160,
    /** Avatare an den gewählten Antworten: ab 500 ms, gestaffelt 150 ms, je 480 ms (ADR-044, docs/09 §7.6/§8) */
    pickersAtMs: 500,
    pickerStaggerMs: STAGGER_MS.pickers,
    pickerMs: DURATION_MS.overlay,
    maxPickers: 4,
    pointsAtMs: 1_200,
    /** Ausblenden 500 ms vor dem Phasenende (wartet die Auflösung auf den Host: gar nicht) */
    exitBeforeEndMs: ANSWER_REVEAL_EXIT_BEFORE_END_MS,
  },
  /** 7 · Zug-Ergebnis (Phase `turn_summary`, Standard 5 s): Sheet fährt von unten hoch (480 ms) */
  turnSummary: {
    sheetMs: DURATION_MS.overlay,
    sheetFrom: "100%",
    squaresAtMs: 600,
    squareMs: DURATION_MS.slow,
  },
  /** 8 · Rundentafel (Phase `round_board`, Standard 7 s): neue Zeilen füllen sich (Board/fillDelayMs) */
  roundBoard: {
    panelMs: DURATION_MS.overlay,
    squareMs: DURATION_MS.slow,
  },
  /** 9 · Spielende (Phase `game_over`, 6 s) */
  gameOver: {
    headlineMs: DURATION_MS.overlay,
    headlineFromScale: 0.96,
    avatarsAtMs: 640,
    avatarMs: DURATION_MS.overlay,
    avatarFromPx: 24,
    crownAtMs: 640 + DURATION_MS.overlay,
    crownMs: DURATION_MS.overlay,
    podiumAtMs: 640,
    podiumStaggerMs: STAGGER_MS.podium,
    columnMs: DURATION_MS.overlay,
  },
} as const;

/** Längste Überblendung bei reduzierter Bewegung (docs/09 §7 „Bewegungsreduktion“). */
export const REDUCED_FADE_MS = DURATION_MS.base;

// ---------------------------------------------------------------------------------------------------
// Einblendungen (motion-Props) mit Fortsetzen
// ---------------------------------------------------------------------------------------------------

export type Bezier = readonly [number, number, number, number];

/**
 * Startwerte einer Einblendung (nur `transform`-Anteile und Deckkraft). Bewusst ein Typ-Alias statt
 * `interface`: nur so ist er den motion-Zielen (mit Index-Signatur für CSS-Variablen) zuweisbar. `y` in px oder
 * relativ zur eigenen Höhe (`"100%"`: ein Sheet fährt um seine ganze Höhe hoch).
 */
export type MotionFrom = {
  opacity?: number;
  x?: number;
  y?: number | `${number}%`;
  scale?: number;
};

export interface EntranceSpec {
  /** geplanter Start relativ zum Anker (ms) */
  at: number;
  /** Dauer (ms) */
  duration: number;
  from: MotionFrom;
  ease?: Bezier;
}

export interface EntranceMotion {
  /** `false` = sofort im Endzustand (Bewegung schon vorbei) */
  initial: false | MotionFrom;
  animate: MotionFrom;
  transition: { duration: number; ease: Bezier; delay: number };
}

/** Endzustand zu den Startwerten: Deckkraft 1, keine Verschiebung, Maßstab 1. */
function restingValues(from: MotionFrom): MotionFrom {
  const target: MotionFrom = {};
  if (from.opacity !== undefined) target.opacity = 1;
  if (from.x !== undefined) target.x = 0;
  if (from.y !== undefined) target.y = 0;
  if (from.scale !== undefined) target.scale = 1;
  return target;
}

/** Ist eine Bewegung (`at` + `duration`) beim Einhängen nach `enteredAt` ms schon vorbei? */
export function entranceDone(at: number, duration: number, enteredAt: number): boolean {
  return enteredAt >= at + duration;
}

/**
 * motion-Props für eine Einblendung, die `enteredAt` ms nach dem Anker eingehängt wird: vorbei → sofort im
 * Endzustand; begonnen → setzt mitten in der Bewegung ein (negative Verzögerung); künftig → pünktlich.
 * Reduzierte Bewegung: nur Deckkraft, höchstens 200 ms (docs/09 §7).
 */
export function enterMotion(spec: EntranceSpec, enteredAt: number, reduce: boolean): EntranceMotion {
  const from: MotionFrom = reduce ? { opacity: spec.from.opacity ?? 0 } : spec.from;
  const duration = reduce ? Math.min(spec.duration, REDUCED_FADE_MS) : spec.duration;
  const ease: Bezier = reduce ? EASING.standard : (spec.ease ?? EASING.emphasized);
  const animate = restingValues(from);
  if (entranceDone(spec.at, duration, enteredAt)) {
    return { initial: false, animate, transition: { duration: 0, ease, delay: 0 } };
  }
  return {
    initial: from,
    animate,
    transition: { duration: seconds(duration), ease, delay: seconds(spec.at - enteredAt) },
  };
}

/**
 * Avatar Nr. `position` an einer Antwort der Auflösung (docs/09 §7.6): gleitet ab 500 ms gestaffelt (150 ms) 12 px von
 * links herein, 480 ms `ease-emphasized` – relativ zum Phasenbeginn, also auch nach einem späten Einhängen pünktlich.
 */
export function answerRevealPickerMotion(position: number, enteredAt: number, reduce: boolean): EntranceMotion {
  const reveal = CHOREOGRAPHY.answerReveal;
  return enterMotion(
    {
      at: reveal.pickersAtMs + position * reveal.pickerStaggerMs,
      duration: reveal.pickerMs,
      from: { opacity: 0, x: -OFFSET_PX.enter },
    },
    enteredAt,
    reduce,
  );
}

/** Verzögerung für Bausteine mit eigener Einblendung (z. B. ResultSquare): `undefined` = schon gefüllt. */
export function remainingDelayMs(at: number, duration: number, enteredAt: number): number | undefined {
  if (entranceDone(at, duration, enteredAt)) return undefined;
  return Math.max(0, at - enteredAt);
}

/** Wurde ein Moment beim Einhängen (`enteredAt`) noch rechtzeitig erreicht? (Ruck, Pop, Flug) */
export function momentAhead(at: number, enteredAt: number, toleranceMs: number): boolean {
  return enteredAt <= at + toleranceMs;
}

// ---------------------------------------------------------------------------------------------------
// Bewegungsreduktion
// ---------------------------------------------------------------------------------------------------

export interface MotionPlan {
  /** wandernder Rahmen bei der Kategoriewahl (Zuschauende) */
  wander: boolean;
  /** Seitwärtsruck bei der eigenen falschen Antwort */
  shake: boolean;
  /** Pop der Krone am Spielende */
  crownPop: boolean;
  /** Flug der gewählten Kachel in den Kategoriestreifen */
  flight: boolean;
  /** Podest-Säulen wachsen */
  podiumGrowth: boolean;
  /** längste Bewegung in ms */
  maxMotionMs: number;
}

export function motionPlan(reduce: boolean): MotionPlan {
  return reduce
    ? { wander: false, shake: false, crownPop: false, flight: false, podiumGrowth: false, maxMotionMs: REDUCED_FADE_MS }
    : { wander: true, shake: true, crownPop: true, flight: true, podiumGrowth: true, maxMotionMs: DURATION_MS.overlay };
}

// ---------------------------------------------------------------------------------------------------
// Bühne: Übergänge, Ausblenden innerhalb einer Phase, wandernder Rahmen
// ---------------------------------------------------------------------------------------------------

/**
 * Übergang beim Wechsel des Overlays: Von der Frage in die Auflösung bleibt die Karte stehen („cut“: die
 * Frage verschwindet ohne Ausblenden, die Auflösung erscheint ohne Einblenden – nur die Zustände wechseln).
 * Sonst blenden Overlays aus (200 ms) und ein (320 ms).
 */
export type StageTransition = "fade" | "cut";

export function stageTransition(kind: StageKind): StageTransition {
  return kind === "answer_reveal" ? "cut" : "fade";
}

/**
 * Serverzeitpunkt, zu dem ein Overlay noch innerhalb seiner Phase ausblendet (docs/09 §7): Intro bei 4.600 ms,
 * Kategorie-Einblendung nach 80 % des Vorlaufs (2.400 von 3.000 ms), Auflösung 500 ms vor ihrem Ende – nicht,
 * wenn sie auf den Host wartet (ADR-045) oder zu kurz ist (schneller Testmodus); sonst `null`.
 */
export function overlayLeaveAt(
  kind: StageKind,
  state: Pick<PublicLobbyState, "phaseStartedAt" | "phaseEndsAt" | "question">,
): number | null {
  switch (kind) {
    case "intro":
      return state.phaseStartedAt + CHOREOGRAPHY.intro.exitAtMs;
    case "category_reveal":
      return state.question ? categoryRevealLeaveAt(state.phaseStartedAt, state.question.startsAt) : null;
    case "answer_reveal": {
      if (state.phaseEndsAt === null) return null;
      const leaveAt = state.phaseEndsAt - CHOREOGRAPHY.answerReveal.exitBeforeEndMs;
      return leaveAt > state.phaseStartedAt + CHOREOGRAPHY.answerReveal.pointsAtMs ? leaveAt : null;
    }
    default:
      return null;
  }
}

/** Kategorie-Einblendung: Ausblenden nach 80 % des Vorlaufs (bei 2.000 ms Vorlauf nach 1.600 ms). */
export function categoryRevealLeaveAt(leadInStartedAt: number, startsAt: number): number {
  const leadIn = Math.max(0, startsAt - leadInStartedAt);
  return leadInStartedAt + Math.round(leadIn * CHOREOGRAPHY.categoryReveal.exitFraction);
}

/** Höchstzahl der Rahmen-Wechsel, für die Zeitpunkte geplant werden (15 s Wahl / 1,2 s ≈ 12). */
const MAX_WANDER_STEPS = 16;

/** Alle Wechselzeitpunkte des wandernden Rahmens innerhalb der Wahl (Serverzeit, für alle gleich). */
export function wanderBoundaries(phaseStartedAt: number, phaseEndsAt: number | null): number[] {
  const step = CHOREOGRAPHY.pick.wanderStepMs;
  const end = phaseEndsAt ?? phaseStartedAt + MAX_WANDER_STEPS * step;
  const times: number[] = [];
  for (let at = phaseStartedAt + step; at < end && times.length < MAX_WANDER_STEPS; at += step) times.push(at);
  return times;
}

/** Wandernder Rahmen der Kategoriewahl: Kachel jetzt und nächster Wechsel (Serverzeit, für alle gleich). */
export function pickHighlight(phaseStartedAt: number, serverNow: number, count = 3): { index: number; nextAt: number } {
  const elapsed = Math.max(0, serverNow - phaseStartedAt);
  const step = CHOREOGRAPHY.pick.wanderStepMs;
  return {
    index: pickHighlightIndex(elapsed, count),
    nextAt: phaseStartedAt + (Math.floor(elapsed / step) + 1) * step,
  };
}

// ---------------------------------------------------------------------------------------------------
// Punkte: „+1“ ab 400 ms der Auflösung
// ---------------------------------------------------------------------------------------------------

type ScoreState = Pick<PublicLobbyState, "phase" | "phaseStartedAt" | "question" | "players">;

/** Punkte, die die laufende Auflösung bringt (+1 je richtiger Antwort; vor `reveal` nie bekannt). */
export function revealGains(state: ScoreState): Map<string, number> {
  const gains = new Map<string, number>();
  const question = state.question;
  if (state.phase !== "reveal" || !question || question.correct === undefined || !question.picks) return gains;
  for (const [playerId, pick] of Object.entries(question.picks)) {
    if (pick === question.correct) gains.set(playerId, 1);
  }
  return gains;
}

/** Sind die Punkte der laufenden Auflösung schon sichtbar? (ab 400 ms, docs/09 §7.6; sonst immer) */
export function pointsShown(state: Pick<PublicLobbyState, "phase" | "phaseStartedAt">, serverNow: number): boolean {
  return state.phase !== "reveal" || serverNow >= state.phaseStartedAt + CHOREOGRAPHY.answerReveal.pointsAtMs;
}

/**
 * Angezeigte Punkte im Spielerstreifen: Der Server zählt die Frage schon ab Beginn der Auflösung mit – das
 * „+1“ erscheint laut docs/09 §7.6 aber erst nach 400 ms. Bis dahin zeigt der Streifen den alten Stand.
 */
export function displayedScores(state: ScoreState, shown: boolean): Record<string, number> {
  const gains = shown ? new Map<string, number>() : revealGains(state);
  const scores: Record<string, number> = {};
  for (const player of state.players) scores[player.id] = player.score - (gains.get(player.id) ?? 0);
  return scores;
}

/** Zeitpunkte, an denen sich {@link displayedScores} ändert. */
export function scoreBoundaries(state: Pick<PublicLobbyState, "phase" | "phaseStartedAt">): number[] {
  return state.phase === "reveal" ? [state.phaseStartedAt + CHOREOGRAPHY.answerReveal.pointsAtMs] : [];
}

// ---------------------------------------------------------------------------------------------------
// Cues: Töne und Haptik zu Serverzeitpunkten
// ---------------------------------------------------------------------------------------------------

export interface StageCue {
  /** eindeutig je Moment (z. B. `tick:<frage>:3`) – jeder Cue feuert höchstens einmal */
  id: string;
  /** Serverzeit */
  at: number;
  sound: SoundName;
  haptic: HapticKind | null;
  /** so lange nach `at` darf der Cue noch feuern (danach entfällt er) */
  lateMs: number;
}

/** Toleranzen: Ticks müssen zur Sekunde passen, Ergebnis-Töne dürfen die Netzlatenz abwarten. */
export const CUE_LATE_MS = { tick: 250, moment: 1_000 } as const;

type CueState = Pick<PublicLobbyState, "phase" | "phaseStartedAt" | "question" | "results"> & {
  settings?: Pick<PublicLobbyState["settings"], "answerSec">;
};

/**
 * Töne und Haptik der aktuellen Phase (docs/09 §7, §10): `turn` zur Kategorie-Einblendung (Kategorie gewählt),
 * `tick` je Sekunde in den letzten 5 s der Frage, `correct`/`wrong` (+ Haptik) für die eigene Antwort in der
 * Auflösung (keine Antwort zählt als falsch), am Spielende `win`/`lose` bzw. `turn` bei Unentschieden.
 * `lock` gehört nicht hierher – er folgt direkt auf das Tippen.
 */
export function stageCues(state: CueState, selfId: string | null): StageCue[] {
  const question = state.question;
  switch (state.phase) {
    case "question": {
      if (!question) return [];
      const cues: StageCue[] = [];
      if (question.index <= 1) {
        cues.push({
          id: `pick:${question.id}`,
          at: state.phaseStartedAt,
          sound: "turn",
          haptic: null,
          lateMs: CUE_LATE_MS.moment,
        });
      }
      // „Zeit pro Frage: Host“ (ADR-049): kein Countdown, also auch kein Ticken.
      const untimed = state.settings?.answerSec === 0;
      for (let secondsLeft = untimed ? 0 : CHOREOGRAPHY.question.tickFromMs / 1000; secondsLeft >= 1; secondsLeft--) {
        const at = question.deadline - secondsLeft * 1000;
        if (at < question.startsAt) continue;
        cues.push({
          id: `tick:${question.id}:${secondsLeft}`,
          at,
          sound: "tick",
          haptic: null,
          lateMs: CUE_LATE_MS.tick,
        });
      }
      return cues;
    }
    case "reveal": {
      const picks = question?.picks;
      if (!question || question.correct === undefined || !picks || selfId === null || !Object.hasOwn(picks, selfId)) {
        return [];
      }
      const right = picks[selfId] === question.correct;
      return [
        {
          id: `result:${question.id}`,
          at: state.phaseStartedAt,
          sound: right ? "correct" : "wrong",
          haptic: right ? "correct" : "wrong",
          lateMs: CUE_LATE_MS.moment,
        },
      ];
    }
    case "game_over": {
      const outcome = state.results ? ownOutcome(state.results, selfId) : null;
      if (outcome === null) return [];
      const sound: SoundName = outcome === "won" ? "win" : outcome === "lost" ? "lose" : "turn";
      return [
        {
          id: `end:${state.phaseStartedAt}`,
          at: state.phaseStartedAt,
          sound,
          haptic: null,
          lateMs: CUE_LATE_MS.moment,
        },
      ];
    }
    default:
      return [];
  }
}

export type CueAction = { kind: "fire" } | { kind: "wait"; inMs: number } | { kind: "skip" };

/** Was mit einem Cue jetzt geschieht: feuern, später feuern oder (schon gefeuert / zu spät) entfallen. */
export function cueAction(cue: StageCue, serverNow: number, fired: ReadonlySet<string>): CueAction {
  if (fired.has(cue.id)) return { kind: "skip" };
  if (serverNow < cue.at) return { kind: "wait", inMs: cue.at - serverNow };
  return serverNow - cue.at <= cue.lateMs ? { kind: "fire" } : { kind: "skip" };
}

export interface CueSchedulerDeps {
  setTimer: (callback: () => void, ms: number) => number;
  clearTimer: (handle: number) => void;
  run: (cue: StageCue) => void;
}

export interface CueScheduler {
  /** Plant die Cues mit der Serverzeit `now` (ersetzt nichts, feuert nichts doppelt); liefert die Abmeldung. */
  schedule(cues: readonly StageCue[], now: () => number): () => void;
  /** IDs bereits gefeuerter bzw. verworfener Cues */
  readonly fired: ReadonlySet<string>;
}

/** Gemerkte Cue-IDs (die ältesten fallen heraus – ein Spiel hat davon höchstens ein paar Hundert). */
const MAX_REMEMBERED_CUES = 500;

/** Plant Cues zu Serverzeitpunkten; jeder Cue feuert höchstens einmal, auch über Neuplanungen hinweg. */
export function createCueScheduler(deps: CueSchedulerDeps): CueScheduler {
  const fired = new Set<string>();
  const remember = (id: string) => {
    fired.add(id);
    if (fired.size > MAX_REMEMBERED_CUES) {
      const oldest = fired.values().next().value;
      if (oldest !== undefined) fired.delete(oldest);
    }
  };
  const settle = (cue: StageCue, now: () => number) => {
    const action = cueAction(cue, now(), fired);
    if (action.kind === "wait") return action;
    remember(cue.id);
    if (action.kind === "fire") deps.run(cue);
    return action;
  };

  return {
    fired,
    schedule(cues, now) {
      const timers: number[] = [];
      // `setTimeout` läuft leicht zu früh oder zu spät: zum Zeitpunkt erneut entscheiden (aufgerundet warten).
      const arm = (cue: StageCue, inMs: number) => {
        timers.push(
          deps.setTimer(() => {
            const next = settle(cue, now);
            if (next.kind === "wait") arm(cue, next.inMs);
          }, Math.ceil(inMs)),
        );
      };
      for (const cue of cues) {
        const action = settle(cue, now);
        if (action.kind === "wait") arm(cue, action.inMs);
      }
      return () => {
        for (const timer of timers) deps.clearTimer(timer);
      };
    },
  };
}

// ---------------------------------------------------------------------------------------------------
// Flug der gewählten Kachel in den Kategoriestreifen (Shared-Layout per FLIP, nur transform/opacity)
// ---------------------------------------------------------------------------------------------------

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface FlightPath {
  from: { x: number; y: number };
  to: { x: number; y: number; scale: number };
}

/**
 * Bahn eines Kachel-Geists, der oben links an (`ghostLeft`, 0) liegt (Ursprung oben links): Start genau über
 * der gewählten Kachel, Ziel linksbündig und senkrecht mittig im Kategoriestreifen, gleichmäßig verkleinert
 * auf die Streifenhöhe (kein Verzerren von Text und Icon).
 */
export function flightPath(from: Box, to: Box, ghostLeft: number): FlightPath {
  const scale = from.height > 0 ? Math.min(1, Math.max(0.3, to.height / from.height)) : 1;
  return {
    from: { x: from.left - ghostLeft, y: from.top },
    to: { x: to.left - ghostLeft, y: to.top + (to.height - from.height * scale) / 2, scale },
  };
}

/** Avatar-Einflug am Spielende (Duell): von außen, links −24 px, rechts +24 px. */
export function sideOffset(side: 0 | 1): number {
  return side === 0 ? -CHOREOGRAPHY.gameOver.avatarFromPx : CHOREOGRAPHY.gameOver.avatarFromPx;
}

/** Standard-Einblendung eines Panels innerhalb eines Overlays (y 12 → 0, 320 ms emphasized). */
export const PANEL_FROM: MotionFrom = { opacity: 0, y: OFFSET_PX.enter };
