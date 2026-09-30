import { Avatar } from "../../../components/ui/avatar";
import { CategoryIcon } from "../../../components/ui/category-icon";
import {
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
  RotateCcwIcon,
  Settings2Icon,
  Share2Icon,
  ShareIcon,
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
} from "../../../lib/ui/icons";
import { PLAYER_COLOR_ORDER } from "../../../lib/ui/player";
import { SAMPLE_CATEGORIES, sampleCategory, samplePlayer, UNKNOWN_CATEGORY } from "./sample-data";
import { ComponentTitle, Demo, Section } from "./section";

const COLOR_SWATCHES = [
  { token: "bg", className: "bg-bg" },
  { token: "surface-1", className: "bg-surface-1" },
  { token: "surface-2", className: "bg-surface-2" },
  { token: "surface-3", className: "bg-surface-3" },
  { token: "line", className: "bg-line" },
  { token: "line-strong", className: "bg-line-strong" },
  { token: "text", className: "bg-text" },
  { token: "text-2", className: "bg-text-2" },
  { token: "text-3", className: "bg-text-3" },
  { token: "primary", className: "bg-primary" },
  { token: "primary-hover", className: "bg-primary-hover" },
  { token: "primary-press", className: "bg-primary-press" },
  { token: "on-primary", className: "bg-on-primary" },
  { token: "success", className: "bg-success" },
  { token: "danger", className: "bg-danger" },
  { token: "primary-tint", className: "bg-primary-tint" },
  { token: "success-tint", className: "bg-success-tint" },
  { token: "danger-tint", className: "bg-danger-tint" },
] as const;

const TYPE_STYLES = [
  { token: "display", className: "text-display tracking-code", sample: "ABC 234" },
  { token: "wordmark", className: "text-wordmark", sample: "quizmaster" },
  { token: "h1", className: "text-h1", sample: "Runde 1" },
  { token: "code", className: "text-code tabular-nums", sample: "0:27" },
  { token: "h2", className: "text-h2", sample: "Spiel verlassen?" },
  { token: "title", className: "text-title", sample: "Bücher & Wörter" },
  { token: "question", className: "text-question", sample: "Wie heißt die Hauptstadt von Australien?" },
  { token: "question-long", className: "text-question-long", sample: "Frage mit mehr als 100 Zeichen" },
  { token: "answer", className: "text-answer", sample: "Canberra" },
  { token: "button", className: "text-button", sample: "Lobby erstellen" },
  { token: "body", className: "text-body", sample: "Das Quiz-Duell für deine Runde." },
  { token: "label", className: "text-label", sample: "Spieler 3/8" },
  { token: "caption", className: "text-caption", sample: "27 Fragen · ca. 9 Min." },
] as const;

const RADII = [
  { token: "sm 6", className: "rounded-sm" },
  { token: "md 12", className: "rounded-md" },
  { token: "lg 16", className: "rounded-lg" },
  { token: "xl 24", className: "rounded-xl" },
] as const;

const SPACING = [
  { px: 4, className: "w-1" },
  { px: 8, className: "w-2" },
  { px: 12, className: "w-3" },
  { px: 16, className: "w-4" },
  { px: 20, className: "w-5" },
  { px: 24, className: "w-6" },
  { px: 32, className: "w-8" },
  { px: 40, className: "w-10" },
  { px: 48, className: "w-12" },
  { px: 64, className: "w-16" },
] as const;

const ICONS: ReadonlyArray<readonly [string, LucideIcon]> = [
  ["chevron-left", ChevronLeftIcon],
  ["x", XIcon],
  ["settings-2", Settings2Icon],
  ["crown", CrownIcon],
  ["copy", CopyIcon],
  ["share-2", Share2Icon],
  ["qr-code", QrCodeIcon],
  ["link", LinkIcon],
  ["play", PlayIcon],
  ["rotate-ccw", RotateCcwIcon],
  ["list-checks", ListChecksIcon],
  ["flag", FlagIcon],
  ["thumbs-up", ThumbsUpIcon],
  ["thumbs-down", ThumbsDownIcon],
  ["user-round-x", UserRoundXIcon],
  ["volume-2", Volume2Icon],
  ["volume-x", VolumeXIcon],
  ["wifi-off", WifiOffIcon],
  ["circle-check", CircleCheckIcon],
  ["circle-x", CircleXIcon],
  ["lock", LockIcon],
  ["timer", TimerIcon],
  ["loader-circle", LoaderCircleIcon],
  ["arrow-up", ArrowUpIcon],
  ["arrow-down", ArrowDownIcon],
  ["triangle-alert", TriangleAlertIcon],
  ["users", UsersIcon],
  ["plus", PlusIcon],
  ["minus", MinusIcon],
  ["smartphone", SmartphoneIcon],
  ["refresh-cw", RefreshCwIcon],
  ["check", CheckIcon],
  ["log-out", LogOutIcon],
  ["share", ShareIcon],
  ["chevron-down", ChevronDownIcon],
  ["chevron-up", ChevronUpIcon],
];

/** Tokens, Typografie, Icons und Farben aus Daten (docs/09 §2, §3, §9). */
export function TokensSection() {
  const revealSample = sampleCategory(0);
  return (
    <Section id="tokens" title="Tokens">
      <ComponentTitle>Farben</ComponentTitle>
      <div className="grid grid-cols-3 gap-3 xs:grid-cols-4">
        {COLOR_SWATCHES.map((swatch) => (
          <div key={swatch.token} className="flex min-w-0 flex-col gap-1">
            <span className={`h-10 w-full rounded-md border border-line ${swatch.className}`} />
            <span className="truncate text-caption text-text-2">{swatch.token}</span>
          </div>
        ))}
      </div>

      <Demo label="Ebenen 0 · 1 · 2 und Scrim (84 %, ohne Unschärfe)">
        <div className="grid grid-cols-2 gap-3">
          <div className="flex h-16 items-center justify-center rounded-xl bg-bg text-caption text-text-2">0 bg</div>
          <div className="flex h-16 items-center justify-center rounded-xl border border-line bg-surface-1 text-caption text-text-2">
            1 surface-1
          </div>
          <div className="flex h-16 items-center justify-center rounded-xl border border-line bg-surface-1 text-caption text-text-2 shadow-level-2">
            2 Schatten
          </div>
          <div className="relative flex h-16 items-center justify-center overflow-hidden rounded-xl bg-primary">
            <span className="absolute inset-0 bg-scrim" />
            <span className="relative text-caption text-text">Scrim</span>
          </div>
        </div>
      </Demo>

      <ComponentTitle>Typografie (Rubik)</ComponentTitle>
      <div className="flex flex-col gap-3">
        {TYPE_STYLES.map((style) => (
          <div key={style.token} className="flex min-w-0 flex-col">
            <span className="text-caption text-text-2">{style.token}</span>
            <span className={`truncate text-text ${style.className}`}>{style.sample}</span>
          </div>
        ))}
      </div>

      <ComponentTitle>Radien und Abstände</ComponentTitle>
      <div className="flex flex-wrap gap-3">
        {RADII.map((radius) => (
          <div key={radius.token} className="flex flex-col items-center gap-1">
            <span className={`size-14 border border-line-strong bg-surface-2 ${radius.className}`} />
            <span className="text-caption text-text-2">{radius.token}</span>
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-1">
        {SPACING.map((space) => (
          <div key={space.px} className="flex items-center gap-3">
            <span className={`h-2 rounded-sm bg-primary ${space.className}`} />
            <span className="text-caption text-text-2 tabular-nums">{space.px}</span>
          </div>
        ))}
      </div>

      <ComponentTitle>Icons</ComponentTitle>
      <div className="grid grid-cols-4 gap-3 xs:grid-cols-5">
        {ICONS.map(([name, Icon]) => (
          <div key={name} className="flex min-w-0 flex-col items-center gap-1">
            <Icon size={24} className="text-text" />
            <span className="max-w-full truncate text-caption text-text-2">{name}</span>
          </div>
        ))}
      </div>

      <ComponentTitle>Kategorien (Farbe als Daten)</ComponentTitle>
      <div className="grid grid-cols-4 gap-3 xs:grid-cols-5">
        {SAMPLE_CATEGORIES.map((category) => (
          <CategoryIcon
            key={category.icon}
            icon={category.icon}
            color={category.color}
            frame="tile"
            label={category.name}
          />
        ))}
        <CategoryIcon
          icon={UNKNOWN_CATEGORY.icon}
          color={UNKNOWN_CATEGORY.color}
          frame="tile"
          label={UNKNOWN_CATEGORY.name}
        />
      </div>
      <Demo label="Reveal-Kachel (einzige Vollfläche in Kategoriefarbe)">
        <CategoryIcon icon={revealSample.icon} color={revealSample.color} frame="reveal" label={revealSample.name} />
      </Demo>

      <ComponentTitle>Spielerfarben</ComponentTitle>
      <div className="flex flex-wrap gap-3">
        {PLAYER_COLOR_ORDER.map((color, index) => (
          <div key={color} className="flex flex-col items-center gap-1">
            <Avatar name={samplePlayer(index).name} color={color} size={40} />
            <span className="text-caption text-text-2">{color}</span>
          </div>
        ))}
      </div>
    </Section>
  );
}
