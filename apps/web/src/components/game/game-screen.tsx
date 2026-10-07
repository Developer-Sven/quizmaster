"use client";

import {
  type AnswerIndex,
  type ContinuePhase,
  isAdvancePhase,
  type PrivatePlayerState,
  type PublicLobbyState,
} from "@quizmaster/shared";
import { type ReactNode, useState } from "react";
import { ActionBar, ActionBarNote } from "@/components/app/action-bar";
import { Banner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { de } from "@/i18n/de";
import {
  type CategoryCatalog,
  categoryVisual,
  findPlayer,
  gameParticipants,
  isRunningPhase,
} from "@/lib/client/game-view";
import { type StageKind, stageAt, stageBoundaries } from "@/lib/client/phase-clock";
import { cx } from "@/lib/ui/cx";
import { usePresenterZoom } from "@/lib/ui/presenter";
import { DURATION_MS } from "@/lib/ui/tokens";
import type { PendingAnswer, PendingPick } from "@/stores/game-store";
import { type CategoryArrival, CategoryStrip } from "./category-strip";
import { displayedScores, pointsShown, scoreBoundaries, stageCues } from "./choreography";
import { Hud } from "./hud";
import { OverlayLayoutContext } from "./overlays/overlay-layout";
import { PlayerStrip, type StripAction } from "./player-strip";
import { PreviewClock } from "./preview-clock";
import { stageAnnouncement } from "./results";
import { GameOverStage, Stage } from "./stage";
import {
  lockFeedback,
  useCompactHeight,
  useGameAudio,
  useGameDocument,
  useRoomyHeight,
  useServerMoment,
  useStageCues,
} from "./use-choreography";

export interface GameHandlers {
  onPick: (categoryId: string) => void;
  onAnswer: (questionId: string, choice: AnswerIndex) => void;
  /** nach Bestätigung „Spiel verlassen?“ (= Aufgeben) */
  onResign: () => void;
  onToggleSound: () => void;
  /** nach Bestätigung „Lobby verlassen?“ (Spielende) */
  onLeave: () => void;
  /** Host: „Weiter“ nach Frage, Kategorie oder Zwischenstand (ADR-045) bzw. „Auflösen“ (ADR-049) */
  onContinue: (phase: ContinuePhase) => void;
  /** Host: Spiel für alle beenden (ADR-051), nach Bestätigung */
  onEndGame: () => void;
  /** „Regeln“ am Spielende als Sheet (ADR-052) */
  onShowRules: () => void;
}

export interface GameBusy {
  leave?: boolean;
  resign?: boolean;
  /** „Weiter“ gesendet, die Phase hat noch nicht gewechselt */
  continue?: boolean;
  /** „Spiel beenden“ gesendet */
  end?: boolean;
}

export interface GameScreenProps {
  lobby: PublicLobbyState;
  self: PrivatePlayerState | null;
  categories: CategoryCatalog;
  pendingAnswer: PendingAnswer | null;
  pendingPick: PendingPick | null;
  syncGeneration: number;
  soundOn: boolean;
  handlers: GameHandlers;
  busy?: GameBusy;
  /** Banner unter dem HUD (Wartung, Update) */
  banner?: ReactNode;
  /**
   * Netzaussetzer im laufenden Spiel (ADR-057): Banner „Verbindung hakt …“ unter dem HUD, angesagt über eine
   * dauerhafte Live-Region
   */
  networkStalled?: boolean;
}

/**
 * Stufen, in denen der Kategoriestreifen die Kategorie des Zuges zeigt: ab ihrer Einblendung bis zum
 * Zug-Ergebnis. Während der Wahl (auch nach dem Tippen) bleibt er leer, damit die gewählte Kachel zur
 * Einblendung hineinfliegen kann; Intro, Rundentafel und Spielende haben keinen laufenden Zug.
 */
const STRIP_STAGES: ReadonlySet<StageKind> = new Set<StageKind>([
  "category_reveal",
  "lead_in",
  "question",
  "answer_reveal",
  "turn_summary",
]);

/**
 * Bis hierhin (ab Beginn des Spielendes) ist das letzte Overlay ausgeblendet und das Spielende eingeblendet;
 * danach wird das Spiel darunter unsichtbar – nur `visibility`, kein Layout-Wechsel (sonst schimmerten die
 * leeren Streifen durch den Scrim).
 */
const GAME_OVER_SETTLED_MS = DURATION_MS.overlay + DURATION_MS.base;

/**
 * Spiel-Screen (docs/09 §7 Grundgerüst): HUD ersetzt die Kopfzeile, darunter der Kategoriestreifen, die
 * Bühne mit den Overlays und unten der Spielerstreifen statt der Aktionsleiste.
 *
 * **Wartet das Spiel auf den Host** (Weiter per Host, ADR-045; Zeit pro Frage „Host“, ADR-049), steht die Aktion
 * in der Zone des Spielerstreifens, nie in einer eigenen Leiste darunter (ADR-060). Der Host sieht kompakt (44 px)
 * die eine orange Aktion, alle anderen in Weiter-Phasen „Warte auf Mia …“ (`ActionBarNote`, kompakt):
 * - Hoher Viewport (ab 50 rem, z. B. 430 × 932, Anzeige-Modus) bzw. Fluss-Layout: in einer zweiten Zeile unter den
 *   Personen über die volle Breite – der Streifen bleibt wie ohne Aktion (bis 4 Personen verteilt, Ringe, „+1“).
 * - Sonst (z. B. 360 × 740: dort fehlte Antwort D samt Avataren die Höhe): „Weiter“ bzw. der Hinweis neben den
 *   Personen (die Liste scrollt, eigene Person zuerst), „Auflösen (2/3 Antworten)“ statt der Personen (der Spielstand
 *   bleibt für Screenreader).
 *
 * Die Choreografie (docs/09 §7–8) läuft an Serverzeitpunkten: die Bühne wechselt ihr Overlay, der Streifen
 * empfängt die gewählte Kategorie, die Punkte steigen 1.200 ms nach Beginn der Auflösung, Töne und Haptik
 * (docs/09 §10) kommen als Cues. Rein darstellend – Daten und Aktionen kommen als Props (Live-Spiel und
 * /dev/game; dort mit eingefrorener bzw. per `?clock=play` laufender Uhr).
 *
 * **Spielende** (docs/09 §6, ADR-038) liegt als eigene Ebene über Kategoriestreifen, Bühne und Spielerstreifen
 * (die darunter inert und unverändert bleiben): Beim Wechsel springt so nichts unter dem ausblendenden Overlay
 * (CLS). Die Ebene hat oben die Banner, in der Mitte das scrollende Ergebnis und unten die Aktionsleiste mit
 * „Gleich geht es zurück in die Lobby …“ und „Lobby verlassen“.
 *
 * **Niedrige Viewports** (`useCompactHeight`, WCAG 1.4.10): Statt einer starren Bühne zwischen festen
 * Leisten scrollt der ganze Screen als ein Dokument – Streifen, Overlay (im Fluss) und Aktionsleiste (nicht
 * klebend) stehen untereinander, nichts verdeckt Inhalt oder Bedienelemente.
 *
 * **Netzaussetzer** (ADR-057): Das Banner „Verbindung hakt …“ ist für Screenreader verborgen; angesagt wird der
 * Text über eine Live-Region, die dauerhaft im DOM steht (nur dann sagen Screenreader die Änderung zuverlässig an).
 */
export function GameScreen(props: GameScreenProps) {
  return (
    <PreviewClock>
      <GameScreenContent {...props} />
    </PreviewClock>
  );
}

function GameScreenContent({
  lobby,
  self,
  categories,
  pendingAnswer,
  pendingPick,
  syncGeneration,
  soundOn,
  handlers,
  busy = {},
  banner,
  networkStalled = false,
}: GameScreenProps) {
  const [leaveOpen, setLeaveOpen] = useState(false);
  /** Frage, deren Antwortgruppe den Fokus nicht bekam – das HUD sagt sie dann an */
  const [unfocusedPrompt, setUnfocusedPrompt] = useState<string | null>(null);
  const compact = useCompactHeight();
  // Zweite Zeile für die Host-Aktion im Spielerstreifen, wo die Bühne sie verträgt (ADR-060).
  const roomy = useRoomyHeight();
  const stackedAction = compact || roomy;
  const selfId = self?.playerId ?? null;
  const selfPlayer = findPlayer(lobby.players, selfId);
  const phase = lobby.phase;
  const gameOver = phase === "game_over";
  // Anzeige-Modus (ADR-046): Der Host spielt nicht mit – großer Bildschirm.
  usePresenterZoom(selfPlayer?.status === "spectator");
  // Wartet die Phase auf den Host? Weiter-Phasen ohne Ende (ADR-045) bzw. Frage ohne Countdown (ADR-049).
  const advancePhase = isAdvancePhase(phase) && lobby.phaseEndsAt === null ? phase : null;
  const untimedQuestion = phase === "question" && lobby.settings.answerSec === 0 ? lobby.question : null;
  const host = lobby.players.find((player) => player.isHost) ?? null;
  const isSelfHost = host !== null && host.id === selfId;
  const questionOpen = useServerMoment(
    (now) => untimedQuestion !== null && now >= untimedQuestion.startsAt,
    untimedQuestion ? [untimedQuestion.startsAt] : [],
  );
  const activeCount = gameParticipants(lobby).filter((player) => player.status === "active").length;
  // Frisch bei jedem Rendern (auch direkt nach einem neuen Zustand) und neu an den Serverzeitpunkten.
  const kind = useServerMoment((now) => stageAt(lobby, now), stageBoundaries(lobby));
  const shownPoints = useServerMoment((now) => pointsShown(lobby, now), scoreBoundaries(lobby));
  const settledAt = lobby.phaseStartedAt + GAME_OVER_SETTLED_MS;
  const gameOverSettled = useServerMoment((now) => gameOver && now >= settledAt, gameOver ? [settledAt] : []);

  useStageCues(stageCues(lobby, selfId));
  useGameAudio(soundOn);
  useGameDocument();

  const progress = lobby.progress
    ? de.game.progress(lobby.progress.round, lobby.progress.rounds, lobby.progress.turn, lobby.progress.turnsPerRound)
    : "";
  const heading = gameOver
    ? de.game.gameOverHeading
    : lobby.progress
      ? de.game.screenHeading(
          lobby.progress.round,
          lobby.progress.rounds,
          lobby.progress.turn,
          lobby.progress.turnsPerRound,
        )
      : null;
  const question = lobby.question;
  const categoryId = STRIP_STAGES.has(kind) ? (lobby.turn?.categoryId ?? question?.categoryId ?? null) : null;
  const fraction =
    question && (phase === "question" || phase === "reveal") ? de.game.fraction(question.index, question.total) : null;
  const arrival: CategoryArrival | null =
    kind === "category_reveal" && categoryId !== null
      ? { id: String(lobby.phaseStartedAt), at: lobby.phaseStartedAt, categoryId }
      : null;
  // Fragetext statt der Phasen-Ansage, solange die Antwortgruppe den Fokus nicht hat (sonst liest sie ihn vor).
  const announcement =
    kind === "question" && question && unfocusedPrompt === question.id
      ? question.prompt
      : stageAnnouncement(lobby, selfId, categories);

  const answer = (questionId: string, choice: AnswerIndex) => {
    // Einloggen (docs/09 §7.5): Ton und Haptik sofort im Handler des Tippens bzw. der Taste.
    lockFeedback();
    handlers.onAnswer(questionId, choice);
  };

  // Host-Aktion in der Zone des Spielerstreifens (ADR-045/049, Lage ADR-060) – die einzige orange Aktion.
  let stripAction: StripAction | null = null;
  if (untimedQuestion !== null && isSelfHost) {
    stripAction = {
      placement: "instead",
      content: (
        <ContinueButton
          label={de.actions.revealNow(untimedQuestion.answeredBy.length, activeCount)}
          block
          disabled={!questionOpen}
          busy={busy.continue === true}
          onContinue={() => handlers.onContinue("question")}
        />
      ),
    };
  } else if (advancePhase !== null) {
    stripAction = {
      placement: "beside",
      content: isSelfHost ? (
        <ContinueButton
          label={de.actions.next}
          block={stackedAction}
          busy={busy.continue === true}
          onContinue={() => handlers.onContinue(advancePhase)}
        />
      ) : (
        <ActionBarNote compact testId="game-continue-waiting">
          {de.lobby.waitingFor(host?.name ?? "")}
        </ActionBarNote>
      ),
    };
  }

  const gameOverLayer = gameOver ? (
    <div className={cx("flex flex-col", compact ? "shrink-0 grow" : "absolute inset-0")}>
      {banner}
      <div className={cx("relative flex w-full flex-col", compact ? "grow" : "min-h-0 flex-1")}>
        <GameOverStage
          results={lobby.results}
          participants={gameParticipants(lobby)}
          board={lobby.board}
          categories={categories}
          questionsPerTurn={lobby.settings.questionsPerCategory}
          selfId={selfId}
          phaseStartedAt={lobby.phaseStartedAt}
          onShowRules={handlers.onShowRules}
        />
      </div>
      <GameOverActions onLeave={() => setLeaveOpen(true)} inFlow={compact} />
    </div>
  ) : null;

  return (
    <div
      data-testid="game-screen"
      data-phase={phase}
      data-layout={compact ? "flow" : "stage"}
      className={cx("fixed inset-0 flex flex-col overscroll-none bg-bg", compact && "overflow-y-auto")}
    >
      <Hud
        progress={progress}
        announcement={announcement}
        canResign={isRunningPhase(phase) && selfPlayer?.status === "active"}
        canEnd={isRunningPhase(phase) && isSelfHost}
        soundOn={soundOn}
        onToggleSound={handlers.onToggleSound}
        onResign={handlers.onResign}
        resigning={busy.resign}
        onEnd={handlers.onEndGame}
        ending={busy.end}
      />
      <main className={cx("relative flex flex-col", compact ? "shrink-0 grow" : "min-h-0 flex-1")}>
        {heading ? <h1 className="sr-only">{heading}</h1> : null}
        {/* Dauerhaft im DOM (auch leer) und außerhalb der inerten Teile: nur so wird „Verbindung hakt“ angesagt. */}
        <p role="status" className="sr-only" data-testid="network-announcer">
          {networkStalled ? de.network.stalled : ""}
        </p>
        <OverlayLayoutContext value={compact ? "flow" : "stage"}>
          {/* Laufendes Spiel. Am Spielende bleibt es (bei normaler Höhe) unverändert unter der Spielende-Ebene
              stehen – inert, damit Fokus, Klicks und Screenreader nur das Ergebnis erreichen. */}
          {compact && gameOver ? null : (
            <div
              inert={gameOver}
              className={cx(
                "flex flex-col",
                compact ? "shrink-0 grow" : "min-h-0 flex-1",
                gameOverSettled && "invisible",
              )}
            >
              {gameOver ? null : banner}
              {networkStalled && !gameOver ? (
                // Sichtbar für alle, vorgelesen nur über die Live-Region oben – sonst käme die Ansage doppelt.
                <div aria-hidden="true" data-testid="network-banner">
                  <Banner tone="network" />
                </div>
              ) : null}
              <CategoryStrip
                category={categoryId ? categoryVisual(categories, categoryId) : null}
                fraction={fraction}
                arrival={arrival}
              />
              <div data-stage="" className={cx("relative flex w-full flex-col", compact ? "grow" : "min-h-0 flex-1")}>
                <Stage
                  kind={gameOver ? "none" : kind}
                  lobby={lobby}
                  self={self}
                  categories={categories}
                  pendingAnswer={pendingAnswer}
                  pendingPick={pendingPick}
                  syncGeneration={syncGeneration}
                  onPick={handlers.onPick}
                  onAnswer={answer}
                  onPromptUnfocused={setUnfocusedPrompt}
                />
              </div>
              <PlayerStrip
                players={gameParticipants(lobby)}
                selfId={selfId}
                answeredIds={phase === "question" && question ? question.answeredBy : []}
                scores={displayedScores(lobby, shownPoints)}
                action={stripAction}
                stacked={stackedAction}
              />
            </div>
          )}
          {gameOverLayer}
        </OverlayLayoutContext>
      </main>
      <Dialog
        open={leaveOpen}
        title={de.dialogs.leaveLobby.title}
        confirmLabel={de.dialogs.leaveLobby.confirm}
        cancelLabel={de.dialogs.leaveLobby.cancel}
        confirming={busy.leave}
        onConfirm={handlers.onLeave}
        onCancel={() => setLeaveOpen(false)}
      />
    </div>
  );
}

interface ContinueButtonProps {
  /** „Weiter“ bzw. „Auflösen (2/3 Antworten)“ */
  label: string;
  /** über die ganze Breite der Zone (statt der Personen bzw. in der zweiten Zeile darunter) */
  block?: boolean;
  /** noch nicht bedienbar (Frage noch im Vorlauf) */
  disabled?: boolean;
  busy: boolean;
  onContinue: () => void;
}

/**
 * Host-Aktion „Weiter“ (ADR-045) bzw. „Auflösen (2/3 Antworten)“ (ADR-049): die einzige orange Aktion, kompakt
 * (44 px, Trefferfläche 48), damit sie in der Zone des Spielerstreifens steht (ADR-060).
 */
function ContinueButton({ label, block = false, disabled = false, busy, onContinue }: ContinueButtonProps) {
  return (
    <Button
      variant="primary"
      size="compact"
      block={block}
      loading={busy}
      disabled={disabled}
      onClick={onContinue}
      data-testid="game-continue"
    >
      {label}
    </Button>
  );
}

interface GameOverActionsProps {
  onLeave: () => void;
  /** niedriger Viewport: Leiste im Dokumentfluss statt unten klebend */
  inFlow: boolean;
}

/**
 * Aktionsleiste am Spielende (ADR-038): Das Ergebnis steht `gameOverMs` (6 s), danach geht es für alle
 * automatisch zurück in die Lobby – dort liegen Ergebnis und „Fragen ansehen“ als Karte „Letztes Spiel“, und der
 * Host startet die nächste Runde. Hier nur der Hinweis und „Lobby verlassen“ (ghost, kompakt).
 */
function GameOverActions({ onLeave, inFlow }: GameOverActionsProps) {
  const bar = (
    <ActionBar>
      <ActionBarNote testId="game-over-returning">{de.result.backToLobbySoon}</ActionBarNote>
      <Button variant="ghost" size="compact" block onClick={onLeave} data-testid="game-over-leave">
        {de.actions.leaveLobby}
      </Button>
    </ActionBar>
  );
  // Die Leiste klebt sonst (sticky) am unteren Rand des scrollenden Screens – bei niedriger Höhe deckte sie
  // das Ergebnis zu. Ein Rahmen genau ihrer Größe hält sie im Fluss.
  return inFlow ? <div className="shrink-0">{bar}</div> : bar;
}
