"use client";

import { useEffect, useEffectEvent, useRef, useState } from "react";
import { Sheet } from "@/components/ui/sheet";
import { de } from "@/i18n/de";
import { lobbyCodeFromScan, ScanError, type ScanFailure, type ScanSession, startQrScan } from "@/lib/client/qr-scan";

export interface QrScannerSheetProps {
  open: boolean;
  onClose: () => void;
  /** erkannter Lobby-Code (normalisiert, 6 Zeichen) – die Kamera ist dann schon aus */
  onCode: (code: string) => void;
}

/**
 * „QR-Code scannen“ (ADR-039): Kamerabild im Sheet, Erkennung bis ein Lobby-QR-Code gelesen ist. Fremde QR-Codes
 * melden „gehört zu keiner Lobby“ und es wird weitergescannt. Wird erst beim Antippen geladen (Startseite ohne
 * Kamera- und Sheet-Code); die Kamera läuft nur, solange das Sheet offen ist.
 */
export function QrScannerSheet({ open, onClose, onCode }: QrScannerSheetProps) {
  return (
    <Sheet open={open} onClose={onClose} title={de.scan.title}>
      <ScannerBody onCode={onCode} />
    </Sheet>
  );
}

type ScanStatus = "starting" | "scanning" | "foreign" | ScanFailure;

const STATUS_TEXT: Record<ScanStatus, string> = {
  starting: de.scan.starting,
  scanning: de.scan.hint,
  foreign: de.scan.foreign,
  unsupported: de.scan.unsupported,
  denied: de.scan.denied,
  "no-camera": de.scan.noCamera,
  failed: de.scan.failed,
};

/** Hängt mit dem offenen Sheet ein und wieder aus – Start und Stopp der Kamera folgen dem Einhängen. */
function ScannerBody({ onCode }: { onCode: (code: string) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState<ScanStatus>("starting");
  // Stabil für den Effekt: ein neuer Callback des Elternteils startet die Kamera nicht neu.
  const reportCode = useEffectEvent((code: string) => onCode(code));

  useEffect(() => {
    const video = videoRef.current;
    if (video === null) return;
    let active = true;
    let session: ScanSession | null = null;
    const handleText = (text: string) => {
      const code = lobbyCodeFromScan(text, window.location.origin);
      if (code === null) {
        setStatus("foreign");
        return;
      }
      active = false;
      session?.stop();
      reportCode(code);
    };
    startQrScan(video, handleText).then(
      (started) => {
        if (!active) {
          started.stop();
          return;
        }
        session = started;
        setStatus("scanning");
      },
      (error: unknown) => {
        if (!active) return;
        console.warn("QR-Scan nicht möglich:", error instanceof ScanError ? error.kind : "unbekannt");
        setStatus(error instanceof ScanError ? error.kind : "failed");
      },
    );
    return () => {
      active = false;
      session?.stop();
    };
  }, []);

  const problem = status !== "starting" && status !== "scanning" && status !== "foreign";
  return (
    <div className="flex flex-col gap-4 pb-4">
      <video
        ref={videoRef}
        aria-label={de.scan.preview}
        playsInline
        muted
        data-testid="qr-scanner-video"
        className="aspect-square w-full rounded-lg bg-surface-2 object-cover"
      />
      <p
        role="status"
        data-testid="qr-scanner-status"
        className={problem ? "text-body text-danger" : "text-body text-text-2"}
      >
        {STATUS_TEXT[status]}
      </p>
    </div>
  );
}
