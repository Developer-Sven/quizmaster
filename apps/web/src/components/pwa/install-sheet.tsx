"use client";

import { de } from "../../i18n/de";
import { EllipsisVerticalIcon, type LucideIcon, ShareIcon, SquarePlusIcon } from "../../lib/ui/icons";
import { Button } from "../ui/button";
import { Sheet } from "../ui/sheet";
import type { InstallStep, InstallStepIcon } from "./install-guide";

const STEP_ICONS: Readonly<Record<InstallStepIcon, LucideIcon>> = {
  share: ShareIcon,
  menu: EllipsisVerticalIcon,
  add: SquarePlusIcon,
};

export interface InstallSheetProps {
  open: boolean;
  steps: readonly InstallStep[];
  onClose: () => void;
}

/**
 * Sheet „App installieren“ (ADR-054): drei nummerierte Schritte für diesen Browser, rechts das Symbol, nach dem man
 * suchen muss (`share`, `ellipsis-vertical`, `square-plus`), darunter, was danach anders ist; secondary „Schließen“.
 */
export function InstallSheet({ open, steps, onClose }: InstallSheetProps) {
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={de.pwa.installTitle}
      footer={
        <Button variant="secondary" block onClick={onClose} data-testid="install-sheet-close">
          {de.actions.close}
        </Button>
      }
    >
      <ol className="flex flex-col gap-4 pb-4" data-testid="install-steps">
        {steps.map((step, index) => {
          const Icon = step.icon === null ? null : STEP_ICONS[step.icon];
          return (
            <li key={step.text} className="flex items-center gap-3">
              <span
                aria-hidden="true"
                className="flex size-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-label text-text tabular-nums"
              >
                {index + 1}
              </span>
              <span className="min-w-0 flex-1 text-body text-text">{step.text}</span>
              {Icon ? <Icon size={24} aria-hidden="true" className="shrink-0 text-text-2" /> : null}
            </li>
          );
        })}
      </ol>
      <p className="pb-2 text-caption text-text-2">{de.pwa.installAfter}</p>
    </Sheet>
  );
}
