import { de } from "../../i18n/de";
import { cx } from "../../lib/ui/cx";
import { CheckIcon, CrownIcon, WifiOffIcon } from "../../lib/ui/icons";
import { initialsOf, type PlayerColor, playerColorBg } from "../../lib/ui/player";

/** Kreisdurchmesser in px (docs/09 §5). */
export type AvatarSize = 24 | 32 | 40 | 56 | 88;

const sizeClasses: Record<AvatarSize, string> = {
  24: "size-6 text-caption",
  32: "size-8 text-label",
  40: "size-10 text-button",
  56: "size-14 text-h2",
  88: "size-22 text-h1",
};

export interface AvatarProps {
  name: string;
  /** Spielerfarbe aus den Daten (`PublicPlayer.color`); unbekannte Werte fallen auf `blue` zurück */
  color: PlayerColor;
  size?: AvatarSize;
  /** Fläche 40 % + `wifi-off`-Badge */
  offline?: boolean;
  /** `crown`-Badge oben rechts */
  host?: boolean;
  /** 2 px Ring `text` + `check`-Badge (mit kurzem Pop) */
  answered?: boolean;
  /** Fläche 40 % (Name daneben durchstreichen) */
  resigned?: boolean;
  /** 2 px Ring `primary` */
  winner?: boolean;
  /**
   * Barrierefreier Name. Ohne ihn ist der Avatar dekorativ (der Name steht daneben);
   * mit ihm werden die Zustände automatisch angehängt („Mia, Host, hat geantwortet“).
   */
  label?: string;
}

/**
 * Avatar (docs/09 §5): Kreis in Spielerfarbe mit Initialen in `bg`. Farben nur als Avatar-Fläche
 * (Regel 3). Zustände: offline, Host, geantwortet, aufgegeben, Sieger:in.
 */
export function Avatar({
  name,
  color,
  size = 40,
  offline = false,
  host = false,
  answered = false,
  resigned = false,
  winner = false,
  label,
}: AvatarProps) {
  const states = [
    host && de.a11y.statusHost,
    offline && de.a11y.statusOffline,
    answered && de.a11y.statusAnswered,
    resigned && de.a11y.statusResigned,
    winner && de.a11y.statusWinner,
  ].filter((state): state is string => typeof state === "string");
  const a11y = label
    ? ({ role: "img", "aria-label": [label, ...states].join(", ") } as const)
    : ({ "aria-hidden": true } as const);
  const ring = winner ? "outline-primary" : answered ? "outline-text" : null;
  const dimmed = offline || resigned;

  return (
    // size-fit: Als Flex-/Grid-Item (stretch) würde der Wrapper sonst breiter als der Kreis – die
    // absolut positionierten Badges säßen dann an der Zellecke statt am Avatar.
    <span {...a11y} className="relative inline-flex size-fit shrink-0">
      <span
        className={cx(
          "relative flex items-center justify-center rounded-full select-none",
          sizeClasses[size],
          ring && `outline-2 outline-offset-2 ${ring}`,
          answered && !winner && "motion-safe:animate-pop",
        )}
      >
        {/* Fläche in Spielerfarbe; offline/aufgegeben mit 40 % Deckkraft */}
        <span className={cx("absolute inset-0 rounded-full", playerColorBg(color), dimmed && "opacity-40")} />
        {/* Initialen in bg; auf der gedimmten Fläche in text, damit sie lesbar bleiben (Kontrast ≥ 4,5:1) */}
        <span className={cx("relative", dimmed ? "text-text" : "text-bg")}>{initialsOf(name)}</span>
      </span>
      {host ? (
        <span className="absolute -top-1 -right-1 flex size-5 items-center justify-center rounded-full bg-bg text-primary">
          <CrownIcon size={14} />
        </span>
      ) : null}
      {offline ? (
        <span className="absolute -right-1 -bottom-1 flex size-4 items-center justify-center rounded-full bg-bg text-text-2">
          <WifiOffIcon size={12} />
        </span>
      ) : answered ? (
        <span className="absolute -right-1 -bottom-1 flex size-4 items-center justify-center rounded-full bg-text text-bg">
          <CheckIcon size={12} />
        </span>
      ) : null}
    </span>
  );
}
