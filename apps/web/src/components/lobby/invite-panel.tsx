"use client";

import { useEffect, useId, useState } from "react";
import { de } from "../../i18n/de";
import { QR_CODE_SIZE, qrCodeDataUrl } from "../../lib/client/qr";
import { CopyIcon, QrCodeIcon, Share2Icon } from "../../lib/ui/icons";
import { Button } from "../ui/button";
import { IconButton } from "../ui/icon-button";
import { Skeleton } from "../ui/skeleton";

export interface InvitePanelProps {
  /** „ABC 234“ */
  displayCode: string;
  /** Einladungslink `https://<origin>/j/<CODE>` für den QR-Code ("" = noch unbekannt) */
  inviteUrl: string;
  onCopyCode: () => void;
  onShare: () => void;
  /** QR-Code anfangs aufgeklappt (Vorschau) */
  defaultQrOpen?: boolean;
}

/**
 * Code-Block der Lobby (docs/09 §6): Code im Stil `display` mit Sperrsatz, IconButtons Kopieren/Teilen,
 * darunter der einklappbare QR-Code (160 × 160) zum Einladungslink.
 * Passen Code und Buttons nicht in eine Zeile (breite Codes wie „MWM WMW“ bei 360 px), rücken die Buttons
 * rechtsbündig in die nächste Zeile – der Code bricht nie am Leerzeichen um und liest sich nie wie zwei Codes.
 * Nur wenn er allein nicht passt (Text-Zoom), bricht er um statt über den Rand zu ragen.
 */
export function InvitePanel({ displayCode, inviteUrl, onCopyCode, onShare, defaultQrOpen = false }: InvitePanelProps) {
  const [qrOpen, setQrOpen] = useState(defaultQrOpen);
  const qrId = useId();
  return (
    <section aria-label={de.fields.lobbyCode} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <p data-testid="lobby-code" className="mr-auto text-display tracking-code text-text tabular-nums">
          {displayCode}
        </p>
        <div className="ml-auto flex gap-2">
          <IconButton icon={CopyIcon} label={de.lobby.copyCode} onClick={onCopyCode} data-testid="lobby-copy" />
          <IconButton icon={Share2Icon} label={de.lobby.shareLink} onClick={onShare} data-testid="lobby-share" />
        </div>
      </div>
      <div className="flex">
        <Button
          variant="ghost"
          size="compact"
          icon={QrCodeIcon}
          aria-expanded={qrOpen}
          aria-controls={qrId}
          onClick={() => setQrOpen((open) => !open)}
          data-testid="lobby-qr-toggle"
        >
          {qrOpen ? de.lobby.hideQrCode : de.lobby.showQrCode}
        </Button>
      </div>
      <div id={qrId} hidden={!qrOpen}>
        {qrOpen && inviteUrl ? <QrImage url={inviteUrl} /> : null}
      </div>
    </section>
  );
}

function QrImage({ url }: { url: string }) {
  const [image, setImage] = useState<{ url: string; src: string } | null>(null);
  // Fehlschlag gilt nur für die URL, zu der er gehört – ein neuer Link versucht es ohne Zurücksetzen erneut.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    qrCodeDataUrl(url).then(
      (src) => {
        if (active) setImage({ url, src });
      },
      (error: unknown) => {
        console.error("QR-Code konnte nicht erzeugt werden:", error instanceof Error ? error.name : "unbekannt");
        if (active) setFailedUrl(url);
      },
    );
    return () => {
      active = false;
    };
  }, [url]);

  if (failedUrl === url) return null;
  if (!image || image.url !== url) {
    return (
      <div className="size-40" aria-busy="true">
        <Skeleton shape="card" />
      </div>
    );
  }
  return (
    // Data-URL aus `qrcode` (docs/09 §6); keine Bildoptimierung nötig.
    // biome-ignore lint/performance/noImgElement: erzeugtes Data-URL-Bild mit fester Größe
    <img
      src={image.src}
      width={QR_CODE_SIZE}
      height={QR_CODE_SIZE}
      alt={de.lobby.qrCodeAlt}
      data-testid="lobby-qr"
      className="size-40 rounded-md"
    />
  );
}
