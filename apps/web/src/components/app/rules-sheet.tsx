"use client";

import { de } from "../../i18n/de";
import { Button } from "../ui/button";
import { Sheet } from "../ui/sheet";
import { RulesList } from "./rules-list";

export interface RulesSheetProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Regeln als Sheet in Lobby und Spielende (ADR-052): ohne Seitenwechsel, die Verbindung zur Lobby bleibt. Ein
 * neuer Tab verlor sie am Handy und in der installierten App – der Lobby-Tab lag im Hintergrund oder wurde
 * ersetzt, „Zur Startseite“ führte aus der Lobby, und nach der Reconnect-Frist war man entfernt. Gleiche Liste
 * wie `/regeln`, unten „Schließen“ (sekundär).
 */
export function RulesSheet({ open, onClose }: RulesSheetProps) {
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={de.rules.title}
      footer={
        <Button variant="secondary" block onClick={onClose} data-testid="rules-sheet-close">
          {de.actions.close}
        </Button>
      }
    >
      <RulesList />
    </Sheet>
  );
}
