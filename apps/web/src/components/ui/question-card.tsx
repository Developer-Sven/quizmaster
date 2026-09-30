import { de } from "../../i18n/de";
import { TimerBar, type TimerBarProps } from "./timer-bar";

/** Fragen mit mehr Zeichen nutzen den kleineren Stil `question-long` (19/27, docs/09 §3). */
export const LONG_QUESTION_CHARS = 100;

/** Flaggen-Code aus `media` (flag-icons, 4x3-SVG unter /flags/) – nur einfache Codes wie `de` oder `gb-sct`. */
const FLAG_CODE = /^[a-z]{2}(?:-[a-z0-9]{1,8})?$/;

export interface QuestionCardProps {
  prompt: string;
  /** Bildfrage (docs/05 `media`): Flagge max. 160 × 120 mit 1 px Rahmen */
  media?: { kind: "flag"; code: string } | null;
  /** TimerBar oben; ohne Wert kein Timer (z. B. in der Auflösung). `runId`: siehe {@link TimerBarProps} */
  timer?: Pick<TimerBarProps, "runId" | "remainingMs" | "durationMs"> | null;
}

/**
 * QuestionCard (docs/09 §5): `surface-1`, `radius-xl`, 20 px Innenabstand, Ebene 1 (1 px `line`),
 * TimerBar oben über die volle Kartenbreite, Fragetext (`question`, ab 101 Zeichen `question-long`),
 * optional Flaggenbild.
 */
export function QuestionCard({ prompt, media, timer }: QuestionCardProps) {
  const flag = media?.kind === "flag" && FLAG_CODE.test(media.code) ? media.code : null;
  return (
    <div className="relative overflow-hidden rounded-xl border border-line bg-surface-1 p-5">
      {timer ? (
        <div className="absolute inset-x-0 top-0">
          <TimerBar runId={timer.runId} remainingMs={timer.remainingMs} durationMs={timer.durationMs} />
        </div>
      ) : null}
      <p className={prompt.length > LONG_QUESTION_CHARS ? "text-question-long text-text" : "text-question text-text"}>
        {prompt}
      </p>
      {flag ? (
        // Flaggen sind statische SVGs aus public/flags (ADR-021); keine Bildoptimierung nötig.
        // biome-ignore lint/performance/noImgElement: SVG-Datei der eigenen Origin, feste Größe
        <img
          src={`/flags/${flag}.svg`}
          alt={de.game.flagAlt}
          width={160}
          height={120}
          className="mt-4 h-30 w-40 max-w-full rounded-sm border border-line object-contain"
        />
      ) : null}
    </div>
  );
}
