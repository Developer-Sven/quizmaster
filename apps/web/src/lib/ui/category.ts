import {
  BookOpenIcon,
  BrainIcon,
  ClapperboardIcon,
  CogIcon,
  Disc3Icon,
  FlaskConicalIcon,
  Gamepad2Icon,
  GlobeIcon,
  HourglassIcon,
  LandmarkIcon,
  LeafIcon,
  type LucideIcon,
  MessageCircleIcon,
  MusicIcon,
  PaletteIcon,
  ScrollTextIcon,
  StarIcon,
  TrophyIcon,
  TvIcon,
  UtensilsIcon,
} from "lucide-react";
import type { CssVariables } from "./cx";

/**
 * Die 19 Kategorie-Icons (docs/09 §2). Der Name kommt als Daten (`CategoryOption.icon`,
 * Quelle content/categories.json → DB); die Kategoriefarbe ebenfalls – sie steht nie im Code.
 */
export const CATEGORY_ICONS = {
  "book-open": BookOpenIcon,
  "message-circle": MessageCircleIcon,
  "gamepad-2": Gamepad2Icon,
  "disc-3": Disc3Icon,
  leaf: LeafIcon,
  utensils: UtensilsIcon,
  "scroll-text": ScrollTextIcon,
  "flask-conical": FlaskConicalIcon,
  clapperboard: ClapperboardIcon,
  brain: BrainIcon,
  palette: PaletteIcon,
  landmark: LandmarkIcon,
  star: StarIcon,
  music: MusicIcon,
  globe: GlobeIcon,
  trophy: TrophyIcon,
  tv: TvIcon,
  cog: CogIcon,
  hourglass: HourglassIcon,
} as const satisfies Readonly<Record<string, LucideIcon>>;

export type CategoryIconName = keyof typeof CATEGORY_ICONS;

/** Darstellungsdaten einer Kategorie (Teil von `CategoryOption`, docs/05). */
export interface CategoryVisual {
  name: string;
  /** Lucide-Icon-Name aus den Daten, z. B. `book-open` */
  icon: string;
  /** Kategoriefarbe aus den Daten als `#RRGGBB` */
  color: string;
}

/** Icon-Komponente zu einem Namen aus den Daten; unbekannte Namen ergeben `null` (kein Absturz). */
export function categoryIconFor(name: string): LucideIcon | null {
  return Object.hasOwn(CATEGORY_ICONS, name) ? CATEGORY_ICONS[name as CategoryIconName] : null;
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/**
 * Setzt die Kategoriefarbe als CSS-Variable `--cat` (genutzt über `text-cat`/`bg-cat`).
 * Nur gültige `#RRGGBB`-Werte – alles andere wird verworfen (kein CSS aus Daten).
 */
export function categoryColorStyle(color: string): CssVariables | undefined {
  return HEX_COLOR.test(color) ? { "--cat": color } : undefined;
}
