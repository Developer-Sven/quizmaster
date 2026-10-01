/**
 * QR-Code des Einladungslinks als Data-URL für ein `<img>` (docs/09 §6 Lobby: 160 × 160, einklappbar).
 * `qrcode` wird erst beim Aufklappen geladen; Farben aus dem Token-Spiegel (dunkle Module in `bg`, heller
 * Grund in `text` – gut scanbar, keine Hex-Werte im UI-Code).
 */
import { QR_CODE_COLORS } from "../ui/tokens";

/** Anzeigegröße in CSS-Pixeln; gerendert wird doppelt so groß (scharf auf Retina-Displays). */
export const QR_CODE_SIZE = 160;

export async function qrCodeDataUrl(text: string): Promise<string> {
  const { toDataURL } = await import("qrcode");
  return toDataURL(text, {
    errorCorrectionLevel: "M",
    margin: 2,
    width: QR_CODE_SIZE * 2,
    color: { dark: QR_CODE_COLORS.dark, light: QR_CODE_COLORS.light },
  });
}
