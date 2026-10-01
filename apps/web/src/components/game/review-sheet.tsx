"use client";

import {
  ANSWER_INDEXES,
  type PublicPlayer,
  type RatingValue,
  REPORT_REASONS,
  type ReportReason,
  type ReviewItem,
} from "@quizmaster/shared";
import { useState } from "react";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { CategoryBadge } from "@/components/ui/category-badge";
import { EmptyState } from "@/components/ui/empty-state";
import { IconButton } from "@/components/ui/icon-button";
import { ListRow } from "@/components/ui/list-row";
import { Sheet } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { de, errorPresentations } from "@/i18n/de";
import { type CategoryCatalog, categoryVisual, pickersByAnswer } from "@/lib/client/game-view";
import { clientTexts } from "@/lib/client/texts";
import { cx } from "@/lib/ui/cx";
import {
  CircleCheckIcon,
  CircleXIcon,
  FlagIcon,
  ListChecksIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
  TriangleAlertIcon,
} from "@/lib/ui/icons";

export type ReviewStatus = "loading" | "ready" | "error";

export interface ReviewSheetProps {
  open: boolean;
  status: ReviewStatus;
  items: readonly ReviewItem[];
  players: readonly PublicPlayer[];
  categories: CategoryCatalog;
  selfId: string | null;
  onClose: () => void;
  onRetry: () => void;
  onRate: (questionId: string, value: RatingValue) => void;
  /** Tippen auf einen Grund sendet sofort; danach zeigt der Sheet wieder die Liste */
  onReport: (questionId: string, reason: ReportReason) => void;
  /** Vorschau: Meldeansicht für diese Frage anfangs offen */
  defaultReportingId?: string | null;
}

/** Flaggen-Code wie in der QuestionCard (nur einfache Codes, Datei aus public/flags). */
const FLAG_CODE = /^[a-z]{2}(?:-[a-z0-9]{1,8})?$/;

/**
 * „Fragen ansehen“ (docs/09 §6, docs/01 §Spielende): je Frage Kategorie-Icon, Frage, alle Antworten mit
 * richtiger (grün) und eigener falscher (rot), Avatare je Antwort, rechts Daumen hoch/runter (orange,
 * wenn aktiv) und Melden. Melden wechselt den Sheet-Inhalt zu den 5 Gründen (kein zweites Sheet).
 */
export function ReviewSheet({
  open,
  status,
  items,
  players,
  categories,
  selfId,
  onClose,
  onRetry,
  onRate,
  onReport,
  defaultReportingId = null,
}: ReviewSheetProps) {
  const [reportingId, setReportingId] = useState<string | null>(defaultReportingId);
  const reporting = reportingId === null ? null : (items.find((item) => item.questionId === reportingId) ?? null);

  return (
    <Sheet
      open={open}
      onClose={() => {
        setReportingId(null);
        onClose();
      }}
      title={reporting ? de.report.title : de.review.title}
      view={reporting ? "report" : "list"}
      onBack={reporting ? () => setReportingId(null) : undefined}
    >
      {reporting ? (
        <ul data-testid="report-reasons" className="flex flex-col pb-2">
          {REPORT_REASONS.map((reason) => (
            <li key={reason}>
              <ListRow
                onClick={() => {
                  setReportingId(null);
                  onReport(reporting.questionId, reason);
                }}
                data-testid={`report-reason-${reason}`}
              >
                {de.report.reasons[reason]}
              </ListRow>
            </li>
          ))}
        </ul>
      ) : status === "loading" ? (
        <div aria-busy="true" className="flex flex-col gap-4 py-2">
          <span className="sr-only">{de.a11y.loading}</span>
          <Skeleton shape="text" />
          <Skeleton shape="block" />
          <Skeleton shape="text" />
          <Skeleton shape="block" />
        </div>
      ) : status === "error" ? (
        <EmptyState
          icon={TriangleAlertIcon}
          message={errorPresentations.INTERNAL.text}
          action={
            <Button variant="secondary" onClick={onRetry}>
              {de.actions.retry}
            </Button>
          }
        />
      ) : items.length === 0 ? (
        <EmptyState icon={ListChecksIcon} message={clientTexts.review.empty} />
      ) : (
        <ol data-testid="review-list" className="flex flex-col">
          {items.map((item) => (
            <ReviewRow
              key={item.questionId}
              item={item}
              players={players}
              categories={categories}
              selfId={selfId}
              onRate={onRate}
              onStartReport={() => setReportingId(item.questionId)}
            />
          ))}
        </ol>
      )}
    </Sheet>
  );
}

interface ReviewRowProps {
  item: ReviewItem;
  players: readonly PublicPlayer[];
  categories: CategoryCatalog;
  selfId: string | null;
  onRate: (questionId: string, value: RatingValue) => void;
  onStartReport: () => void;
}

function ReviewRow({ item, players, categories, selfId, onRate, onStartReport }: ReviewRowProps) {
  const pickers = pickersByAnswer(item.picks, players);
  const myPick = selfId === null ? null : (item.picks[selfId] ?? null);
  const flag = item.media?.kind === "flag" && FLAG_CODE.test(item.media.code) ? item.media.code : null;
  return (
    <li
      data-testid="review-item"
      data-question-id={item.questionId}
      className="flex flex-col gap-3 border-b border-line py-4"
    >
      <div className="flex items-start gap-3">
        <CategoryBadge category={categoryVisual(categories, item.categoryId)} compact />
        <p className="min-w-0 flex-1 text-body text-text">{item.prompt}</p>
      </div>
      {flag ? (
        // Flaggen-SVG der eigenen Origin (ADR-021), feste Größe.
        // biome-ignore lint/performance/noImgElement: statische SVG-Datei, keine Bildoptimierung nötig
        <img
          src={`/flags/${flag}.svg`}
          alt={de.game.flagAlt}
          width={80}
          height={60}
          className="h-15 w-20 rounded-sm border border-line object-contain"
        />
      ) : null}
      <ul className="flex flex-col gap-2">
        {ANSWER_INDEXES.map((choice) => {
          const correct = choice === item.correct;
          const ownWrong = !correct && choice === myPick;
          const chosenBy = pickers[choice] ?? [];
          return (
            <li key={choice} className="flex min-h-8 items-center gap-2">
              {correct ? (
                <CircleCheckIcon size={16} aria-hidden="true" className="shrink-0 text-success" />
              ) : ownWrong ? (
                <CircleXIcon size={16} aria-hidden="true" className="shrink-0 text-danger" />
              ) : (
                <span aria-hidden="true" className="size-4 shrink-0" />
              )}
              <span
                className={cx(
                  "min-w-0 flex-1 text-label",
                  correct ? "text-success" : ownWrong ? "text-danger" : "text-text-2",
                )}
              >
                {item.answers[choice]}
                {correct ? <span className="sr-only">, {de.review.correctAnswer}</span> : null}
                {choice === myPick ? <span className="sr-only">, {de.review.yourAnswer}</span> : null}
                {chosenBy.length > 0 ? (
                  <span className="sr-only">, {de.a11y.pickedBy(chosenBy.map((picker) => picker.name))}</span>
                ) : null}
              </span>
              <span aria-hidden="true" className="flex shrink-0 -space-x-1">
                {chosenBy.map((picker) => (
                  <span key={picker.id} className="flex rounded-full outline-2 outline-surface-1">
                    <Avatar name={picker.name} color={picker.color} size={24} />
                  </span>
                ))}
              </span>
            </li>
          );
        })}
      </ul>
      {item.explanation ? <p className="text-caption text-text-2">{item.explanation}</p> : null}
      <div className="flex items-center justify-end gap-1">
        <IconButton
          icon={ThumbsUpIcon}
          label={de.review.rateUp}
          pressed={item.myRating === 1}
          onClick={() => onRate(item.questionId, 1)}
          data-testid="review-rate-up"
        />
        <IconButton
          icon={ThumbsDownIcon}
          label={de.review.rateDown}
          pressed={item.myRating === -1}
          onClick={() => onRate(item.questionId, -1)}
          data-testid="review-rate-down"
        />
        <IconButton
          icon={FlagIcon}
          label={item.myReported ? de.review.reported : de.review.report}
          disabled={item.myReported}
          onClick={onStartReport}
          data-testid="review-report"
        />
      </div>
    </li>
  );
}
