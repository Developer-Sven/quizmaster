import { TriangleAlertIcon } from "@/lib/ui/icons";

export interface FormErrorProps {
  /** Fehlertext (`null` = nichts anzeigen) */
  message: string | null;
  testId?: string;
}

/**
 * Fehlerzeile unter einer Aktion – dieselbe Gestalt wie der Fehlertext von TextField und CodeInput
 * (docs/09 §5: `caption`, rot, `triangle-alert` 16). Auf Start- und Beitreten-Seite statt eines Toasts,
 * damit dort kein Animations-Code geladen wird (docs/07: wenig JS auf `/`).
 */
export function FormError({ message, testId }: FormErrorProps) {
  if (!message) return null;
  return (
    <p role="alert" data-testid={testId} className="flex items-center gap-1 text-caption text-danger">
      <TriangleAlertIcon size={16} className="shrink-0" />
      {message}
    </p>
  );
}
