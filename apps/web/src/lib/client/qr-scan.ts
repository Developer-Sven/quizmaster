/**
 * Lobby-QR-Code mit der Kamera scannen (ADR-039). Erkennung nativ über `BarcodeDetector` (Android/Chrome, macOS),
 * sonst mit `jsqr` auf Kamerabildern (iPhone/Safari, Firefox, Desktop) – `jsqr` lädt erst beim Scannen nach.
 * Aus dem gelesenen Text zählt nur ein Einladungslink DIESER Origin (`…/j/ABC234`) oder ein reiner Code; fremde
 * Adressen werden nie geöffnet. Die Kamera läuft nur, solange gescannt wird (`stop()` beendet alle Spuren).
 */
import { LOBBY_CODE_LENGTH, normalizeCodeInput } from "../ui/lobby-code";

/** Warum nicht gescannt werden kann. */
export type ScanFailure = "unsupported" | "denied" | "no-camera" | "failed";

export class ScanError extends Error {
  readonly kind: ScanFailure;

  constructor(kind: ScanFailure) {
    super(`QR-Scan nicht möglich: ${kind}`);
    this.name = "ScanError";
    this.kind = kind;
  }
}

export interface ScanSession {
  stop(): void;
}

/** Abstand zwischen zwei Erkennungsversuchen (ms): flüssig genug, ohne das Gerät zu belasten. */
const SCAN_INTERVAL_MS = 200;
/** Längste Bildkante für `jsqr` (px) – größere Kamerabilder werden verkleinert. */
const MAX_SCAN_EDGE = 640;
const BARE_CODE = /^[A-Za-z0-9 -]{6,9}$/;
const INVITE_PATH = /^\/j\/([^/]+)\/?$/;

/** Lobby-Code aus einem gescannten Text: Einladungslink derselben Origin oder reiner Code – sonst `null`. */
export function lobbyCodeFromScan(text: string, origin: string): string | null {
  const value = text.trim();
  if (BARE_CODE.test(value)) return complete(normalizeCodeInput(value));
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null; // weder Code noch URL
  }
  if (url.origin !== origin) return null;
  const match = INVITE_PATH.exec(url.pathname);
  if (!match?.[1]) return null;
  let segment: string;
  try {
    segment = decodeURIComponent(match[1]);
  } catch {
    return null; // kaputte Prozent-Kodierung
  }
  return complete(normalizeCodeInput(segment));
}

function complete(code: string): string | null {
  return code.length === LOBBY_CODE_LENGTH ? code : null;
}

/** Kann dieser Browser überhaupt eine Kamera öffnen (sicherer Kontext, MediaDevices)? */
export function canScan(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function";
}

interface Detector {
  detect(video: HTMLVideoElement): Promise<string | null>;
}

/** `BarcodeDetector` (Shape Detection API) – nicht in den DOM-Typen. */
interface NativeBarcodeDetector {
  detect(source: HTMLVideoElement): Promise<ReadonlyArray<{ rawValue: string }>>;
}
interface NativeBarcodeDetectorConstructor {
  new (options: { formats: string[] }): NativeBarcodeDetector;
  getSupportedFormats(): Promise<string[]>;
}

async function nativeDetector(): Promise<Detector | null> {
  const Native = (globalThis as { BarcodeDetector?: NativeBarcodeDetectorConstructor }).BarcodeDetector;
  if (Native === undefined) return null;
  try {
    if (!(await Native.getSupportedFormats()).includes("qr_code")) return null;
    const detector = new Native({ formats: ["qr_code"] });
    return {
      async detect(video) {
        const codes = await detector.detect(video);
        return codes[0]?.rawValue ?? null;
      },
    };
  } catch (error) {
    console.warn("BarcodeDetector nicht nutzbar, Fallback jsqr:", error instanceof Error ? error.name : "unbekannt");
    return null;
  }
}

async function jsqrDetector(): Promise<Detector> {
  const { default: jsQR } = await import("jsqr");
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (context === null) throw new ScanError("unsupported");
  return {
    async detect(video) {
      const { videoWidth: width, videoHeight: height } = video;
      if (width === 0 || height === 0) return null;
      const scale = Math.min(1, MAX_SCAN_EDGE / Math.max(width, height));
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const image = context.getImageData(0, 0, canvas.width, canvas.height);
      return jsQR(image.data, image.width, image.height, { inversionAttempts: "dontInvert" })?.data ?? null;
    },
  };
}

function failureOf(error: unknown): ScanFailure {
  if (error instanceof ScanError) return error.kind;
  const name = error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "denied";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "no-camera";
  return "failed";
}

/**
 * Startet Kamera und Erkennung auf `video`; `onText` bekommt jeden erkannten Text (auch fremde – die Auswertung
 * macht der Aufrufer). Wirft `ScanError` (unsupported, denied, no-camera, failed).
 */
export async function startQrScan(video: HTMLVideoElement, onText: (text: string) => void): Promise<ScanSession> {
  if (!canScan()) throw new ScanError("unsupported");
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" } },
      audio: false,
    });
  } catch (error) {
    throw new ScanError(failureOf(error));
  }
  let running = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    running = false;
    if (timer !== undefined) clearTimeout(timer);
    for (const track of stream.getTracks()) track.stop();
    video.srcObject = null;
  };
  try {
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play();
    const detector = (await nativeDetector()) ?? (await jsqrDetector());
    const tick = async () => {
      if (!running) return;
      try {
        const text = await detector.detect(video);
        if (running && text) onText(text);
      } catch (error) {
        console.warn("QR-Erkennung fehlgeschlagen:", error instanceof Error ? error.name : "unbekannt");
      }
      if (running) timer = setTimeout(() => void tick(), SCAN_INTERVAL_MS);
    };
    void tick();
  } catch (error) {
    stop();
    throw new ScanError(failureOf(error));
  }
  return { stop };
}
