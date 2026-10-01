"use client";

import { de } from "../../i18n/de";
import { ShareIcon, SmartphoneIcon } from "../../lib/ui/icons";
import { Button } from "../ui/button";
import { ListRow } from "../ui/list-row";
import { Sheet } from "../ui/sheet";

export interface IosInstallSheetProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Anleitungs-Sheet für iOS/iPadOS (docs/10): Safari kennt kein Install-Event – „Teilen“ (`share`) und dann
 * „Zum Home-Bildschirm“. Seit iOS 26 öffnet die Verknüpfung standardmäßig als Web-App.
 */
export function IosInstallSheet({ open, onClose }: IosInstallSheetProps) {
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={de.pwa.iosInstallTitle}
      footer={
        <Button variant="primary" block onClick={onClose} data-testid="ios-install-done">
          {de.actions.done}
        </Button>
      }
    >
      <ol data-testid="ios-install-sheet" className="flex flex-col">
        <li>
          <ListRow icon={ShareIcon}>{de.pwa.iosInstallShare}</ListRow>
        </li>
        <li>
          <ListRow icon={SmartphoneIcon}>{de.pwa.iosInstallHomeScreen}</ListRow>
        </li>
      </ol>
    </Sheet>
  );
}
