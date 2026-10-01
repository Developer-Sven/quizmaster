"use client";

import { type FormEvent, useState } from "react";
import { de } from "../../i18n/de";
import { Button } from "../ui/button";
import { Sheet } from "../ui/sheet";
import { TextField } from "../ui/text-field";

/** Wie auf der Startseite: Eingabe bis 64 Zeichen, die Regeln (2–16 Zeichen …) prüft der Server. */
const NAME_MAX_LENGTH = 64;

export interface RenameSheetProps {
  open: boolean;
  /** Bisheriger Name (vorbelegt) */
  name: string;
  /** Sendet den neuen Namen; liefert eine Fehlermeldung oder `null` bei Erfolg */
  onSubmit: (name: string) => Promise<string | null>;
  onClose: () => void;
}

/**
 * Eigenen Namen in der Lobby ändern (ADR-041): Sheet mit Namensfeld und „Speichern“. Leere Eingaben weist das
 * Feld selbst zurück, alle anderen Regeln (Länge, Zeichen, Moderation) prüft der Server → „Name nicht erlaubt.“
 */
export function RenameSheet({ open, name, onSubmit, onClose }: RenameSheetProps) {
  return (
    <Sheet open={open} onClose={onClose} title={de.actions.rename}>
      {/* Neu eingehängt bei jedem Öffnen: das Feld startet mit dem aktuellen Namen, ohne alten Fehler. */}
      {open ? <RenameForm name={name} onSubmit={onSubmit} onClose={onClose} /> : null}
    </Sheet>
  );
}

function RenameForm({ name, onSubmit, onClose }: Omit<RenameSheetProps, "open">) {
  const [value, setValue] = useState(name);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const trimmed = value.trim();
    if (trimmed === "") {
      setError(de.start.nameRequired);
      return;
    }
    if (trimmed === name) {
      onClose();
      return;
    }
    setBusy(true);
    const failure = await onSubmit(trimmed);
    setBusy(false);
    if (failure === null) onClose();
    else setError(failure);
  };

  return (
    <form
      noValidate
      onSubmit={(event) => void submit(event)}
      className="flex flex-col gap-4 pb-2"
      data-testid="rename-form"
    >
      <TextField
        label={de.fields.name}
        value={value}
        error={error}
        onChange={(event) => {
          setValue(event.target.value);
          setError(null);
        }}
        name="name"
        autoComplete="nickname"
        autoCapitalize="words"
        enterKeyHint="done"
        maxLength={NAME_MAX_LENGTH}
        data-testid="rename-name"
      />
      <Button type="submit" variant="primary" block loading={busy} data-testid="rename-save">
        {de.actions.save}
      </Button>
    </form>
  );
}
