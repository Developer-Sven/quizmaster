import type { ReactNode } from "react";
import type { LucideIcon } from "../../lib/ui/icons";

export interface EmptyStateProps {
  /** Icon 40 in `text-3`, z. B. `wifi-off` für offline */
  icon: LucideIcon;
  /** eine Zeile, z. B. „Lobby nicht gefunden.“ */
  message: string;
  /** Überschrift-Ebene: `h1` auf eigenen Seiten (Fehler, offline), sonst Absatz */
  as?: "h1" | "h2" | "p";
  /** optional ein Button, z. B. `<ButtonLink variant="primary" href="/">Zur Startseite</ButtonLink>` */
  action?: ReactNode;
}

/** EmptyState (docs/09 §5): Icon 40 in `text-3` · eine Zeile · optional Button. */
export function EmptyState({ icon: Icon, message, as: Heading = "p", action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center gap-4 py-12 text-center">
      <Icon size={40} className="text-text-3" />
      <Heading className="text-title text-text">{message}</Heading>
      {action ? <div className="flex w-full justify-center">{action}</div> : null}
    </div>
  );
}
