"use client";

import { useState } from "react";
import { Banner } from "../../../components/ui/banner";
import { Button, ButtonLink } from "../../../components/ui/button";
import { CategoryBadge } from "../../../components/ui/category-badge";
import { Dialog } from "../../../components/ui/dialog";
import { EmptyState } from "../../../components/ui/empty-state";
import { IconButton } from "../../../components/ui/icon-button";
import { ListRow } from "../../../components/ui/list-row";
import { Sheet } from "../../../components/ui/sheet";
import { Skeleton } from "../../../components/ui/skeleton";
import { Stepper } from "../../../components/ui/stepper";
import { Toast, type ToastTone } from "../../../components/ui/toast";
import { de, errorMessage } from "../../../i18n/de";
import {
  CrownIcon,
  FlagIcon,
  ListChecksIcon,
  Settings2Icon,
  TriangleAlertIcon,
  WifiOffIcon,
  XIcon,
} from "../../../lib/ui/icons";
import { LONG_MAINTENANCE_MESSAGE, SHORT_QUESTION, sampleCategory } from "./sample-data";
import { ComponentTitle, Demo, Section } from "./section";

type SheetView = "settings" | "review" | "report" | null;

/** Beispiel mit 3 Personen in der Lobby. */
const DEMO_PLAYERS = 3;

/** Dauer-Schätzung aus docs/01 (Sekunden → Minuten), hier nur für die Beispielzeile. */
function estimatedMinutes(rounds: number, players: number, perCategory: number): number {
  return Math.round((4 + rounds * (players * (6 + 2 + perCategory * 15 + 4) + 6)) / 60);
}

interface ToastMessage {
  text: string;
  tone: ToastTone;
  withCrown: boolean;
}

/** Sheet, Dialog, Toast, Banner, Skeleton, EmptyState. */
export function LayersSection() {
  const [sheet, setSheet] = useState<SheetView>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [settings, setSettings] = useState({ rounds: 3, questionsPerCategory: 3, maxPlayers: 8 });
  const questions = settings.rounds * DEMO_PLAYERS * settings.questionsPerCategory;

  const report = () => {
    setSheet("review");
    setToast({ text: de.report.thanks, tone: "info", withCrown: false });
  };

  return (
    <Section id="layers" title="Ebenen und Zustände">
      <ComponentTitle>Sheet</ComponentTitle>
      <div className="flex flex-col gap-3">
        <Button variant="secondary" icon={Settings2Icon} block onClick={() => setSheet("settings")}>
          {de.settings.title}
        </Button>
        <Button variant="secondary" icon={ListChecksIcon} block onClick={() => setSheet("review")}>
          {de.actions.reviewQuestions}
        </Button>
      </div>
      <Sheet
        open={sheet !== null}
        onClose={() => setSheet(null)}
        view={sheet ?? undefined}
        title={sheet === "settings" ? de.settings.title : sheet === "report" ? de.report.title : de.review.title}
        onBack={sheet === "report" ? () => setSheet("review") : undefined}
        footer={
          sheet === "settings" ? (
            <Button variant="primary" block onClick={() => setSheet(null)}>
              {de.actions.done}
            </Button>
          ) : undefined
        }
      >
        {sheet === "settings" ? (
          <div className="flex flex-col">
            <Stepper
              label={de.settings.rounds}
              value={settings.rounds}
              min={1}
              max={10}
              onChange={(rounds) => setSettings((current) => ({ ...current, rounds }))}
            />
            <Stepper
              label={de.settings.questionsPerCategory}
              value={settings.questionsPerCategory}
              min={1}
              max={10}
              onChange={(questionsPerCategory) => setSettings((current) => ({ ...current, questionsPerCategory }))}
            />
            <Stepper
              label={de.settings.maxPlayers}
              value={settings.maxPlayers}
              min={2}
              max={8}
              onChange={(maxPlayers) => setSettings((current) => ({ ...current, maxPlayers }))}
            />
            <p className="pt-2 text-label text-text-2">
              {de.lobby.settingsSummary(settings.rounds, settings.questionsPerCategory)} ·{" "}
              {de.lobby.durationSummary(
                questions,
                estimatedMinutes(settings.rounds, DEMO_PLAYERS, settings.questionsPerCategory),
              )}
            </p>
          </div>
        ) : null}
        {sheet === "review" ? (
          <ul className="flex flex-col">
            {[0, 13, 8].map((index) => (
              <li key={index} className="flex items-center gap-3 border-b border-line py-3">
                <CategoryBadge category={sampleCategory(index)} compact />
                <span className="min-w-0 flex-1 text-body text-text">{SHORT_QUESTION}</span>
                <IconButton icon={FlagIcon} label={de.review.report} onClick={() => setSheet("report")} />
              </li>
            ))}
          </ul>
        ) : null}
        {sheet === "report" ? (
          <div className="flex flex-col">
            {Object.entries(de.report.reasons).map(([reason, label]) => (
              <ListRow key={reason} onClick={report}>
                {label}
              </ListRow>
            ))}
          </div>
        ) : null}
      </Sheet>

      <ComponentTitle>Dialog</ComponentTitle>
      <Button variant="ghost" icon={XIcon} onClick={() => setDialogOpen(true)}>
        {de.game.resign}
      </Button>
      <Dialog
        open={dialogOpen}
        title={de.dialogs.resign.title}
        description={de.dialogs.resign.description}
        confirmLabel={de.dialogs.resign.confirm}
        cancelLabel={de.dialogs.resign.cancel}
        onConfirm={() => setDialogOpen(false)}
        onCancel={() => setDialogOpen(false)}
      />

      <ComponentTitle>Toast</ComponentTitle>
      <div className="grid grid-cols-2 gap-3">
        <Button
          variant="secondary"
          size="compact"
          onClick={() => setToast({ text: de.notices.hostChanged("Ben"), tone: "info", withCrown: true })}
        >
          Info
        </Button>
        <Button
          variant="secondary"
          size="compact"
          // längster Fehlertext aus docs/09 §11: bricht bei 360 px auf zwei Zeilen um
          onClick={() =>
            setToast({ text: errorMessage("TOO_MANY_CONNECTIONS") ?? "", tone: "error", withCrown: false })
          }
        >
          Fehler
        </Button>
      </div>
      <Toast
        message={toast?.text ?? null}
        tone={toast?.tone}
        icon={toast?.withCrown ? CrownIcon : undefined}
        onDismiss={() => setToast(null)}
      />

      <ComponentTitle>Banner</ComponentTitle>
      <div className="-mx-4 flex flex-col gap-3 xs:-mx-5">
        <Banner tone="maintenance" message={de.maintenance.message(null)} />
        <Banner tone="maintenance" message={de.maintenance.message(LONG_MAINTENANCE_MESSAGE)} />
        <Banner tone="update" onAction={() => {}} />
      </div>

      <ComponentTitle>Skeleton</ComponentTitle>
      <div aria-busy="true" className="flex flex-col gap-3">
        <span className="sr-only">{de.a11y.loading}</span>
        <div className="flex items-center gap-3">
          <Skeleton shape="avatar" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton shape="text" />
            <Skeleton shape="text" />
          </div>
        </div>
        <Skeleton shape="block" />
        <Skeleton shape="answer" />
        <Skeleton shape="tile" />
        <Skeleton shape="card" />
      </div>

      <ComponentTitle>EmptyState</ComponentTitle>
      <Demo label="Fehlerseite">
        <EmptyState
          icon={TriangleAlertIcon}
          message={errorMessage("LOBBY_NOT_FOUND") ?? ""}
          action={
            <ButtonLink variant="primary" href="/dev/ui">
              {de.actions.toStart}
            </ButtonLink>
          }
        />
      </Demo>
      <Demo label="offline">
        <EmptyState
          icon={WifiOffIcon}
          message={de.pwa.offline}
          action={
            <Button variant="secondary" onClick={() => {}}>
              {de.actions.retry}
            </Button>
          }
        />
      </Demo>
    </Section>
  );
}
