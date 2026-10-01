/**
 * Die einzigen erlaubten UI-Icons (docs/09 §9, Lucide, Strichstärke 2). Weitere Icons nur über eine
 * Änderung an docs/09. Kategorie-Icons liegen in ./category.ts. Importiere Icons immer von hier,
 * nie direkt aus `lucide-react` (design-rules.test.ts prüft das).
 *
 * | Zweck                                   | Icon               |
 * |-----------------------------------------|--------------------|
 * | zurück / verlassen (Lobby)              | ChevronLeftIcon    |
 * | Aufgeben (Spiel)                        | XIcon              |
 * | Einstellungen                           | Settings2Icon      |
 * | Host, Sieger:in                         | CrownIcon          |
 * | Code kopieren / Link teilen             | CopyIcon / Share2Icon |
 * | QR-Code / Link                          | QrCodeIcon / LinkIcon |
 * | Spiel starten                           | PlayIcon           |
 * | Fragen ansehen / Melden                 | ListChecksIcon / FlagIcon |
 * | Bewertung                               | ThumbsUpIcon / ThumbsDownIcon |
 * | Entfernen                               | UserRoundXIcon     |
 * | Ton an / aus                            | Volume2Icon / VolumeXIcon |
 * | Offline                                 | WifiOffIcon        |
 * | Richtig / Falsch                        | CircleCheckIcon / CircleXIcon |
 * | Richtig / Falsch im Ergebnis-Kästchen   | CheckIcon / XIcon (12 px)     |
 * | Eingeloggt / Zeit / Laden               | LockIcon / TimerIcon / LoaderCircleIcon |
 * | Platz hoch / runter                     | ArrowUpIcon / ArrowDownIcon |
 * | Warnung/Fehler                          | TriangleAlertIcon  |
 * | Spieleranzahl                           | UsersIcon          |
 * | mehr / weniger                          | PlusIcon / MinusIcon |
 * | App installieren / Aktualisieren        | SmartphoneIcon / RefreshCwIcon |
 * | geantwortet / ausgewählt                | CheckIcon          |
 * | hat aufgegeben (Toast)                  | LogOutIcon         |
 * | aufklappen / zuklappen (auch Sheet zu)  | ChevronDownIcon / ChevronUpIcon |
 *
 * Größen: 16 / 20 / 24 / 32 / 40 / 48 px, in Avatar-Badges 12 / 14 px ({@link ICON_SIZE}).
 * Icon-only-Buttons brauchen ein `aria-label` (IconButton erzwingt das).
 */
export {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronUpIcon,
  CircleCheckIcon,
  CircleXIcon,
  CopyIcon,
  CrownIcon,
  FlagIcon,
  LinkIcon,
  ListChecksIcon,
  LoaderCircleIcon,
  LockIcon,
  LogOutIcon,
  type LucideIcon,
  MinusIcon,
  PlayIcon,
  PlusIcon,
  QrCodeIcon,
  RefreshCwIcon,
  Settings2Icon,
  Share2Icon,
  SmartphoneIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
  TimerIcon,
  TriangleAlertIcon,
  UserRoundXIcon,
  UsersIcon,
  Volume2Icon,
  VolumeXIcon,
  WifiOffIcon,
  XIcon,
} from "lucide-react";

/** Erlaubte Icon-Größen in px (docs/09 §9). */
export const ICON_SIZE = { badge: 12, crown: 14, sm: 16, md: 20, lg: 24, xl: 32, xxl: 40, huge: 48 } as const;

export type IconSize = (typeof ICON_SIZE)[keyof typeof ICON_SIZE];
