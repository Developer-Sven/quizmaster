"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { FormError } from "@/components/app/form-error";
import { InstallRow } from "@/components/pwa/install-row";
import { UpdateBanner } from "@/components/pwa/update-banner";
import { Button } from "@/components/ui/button";
import { CodeInput } from "@/components/ui/code-input";
import { TextField } from "@/components/ui/text-field";
import { de } from "@/i18n/de";
import {
  type ClientErrorCode,
  createErrorPlacement,
  type ErrorPlacement,
  errorText,
  joinErrorPlacement,
} from "@/lib/client/errors";
import { loadRealtimeClient, warmUpRealtimeClient } from "@/lib/client/load-realtime";
import { lobbyPath } from "@/lib/client/paths";
import type { RealtimeClient } from "@/lib/client/realtime-client";
import { readStoredName, writeStoredName } from "@/lib/client/storage";
import { LOBBY_CODE_LENGTH } from "@/lib/ui/lobby-code";

/** Obergrenze des Namensfelds (NAME_INPUT_MAX_LENGTH; die Namensregeln prüft der Server). */
const NAME_MAX_LENGTH = 64;

export interface StartScreenProps {
  /** Realtime-URL aus der Laufzeit-Konfiguration ("" = gleiche Origin, ADR-023) */
  realtimeUrl: string;
  /** PWA-Kurzbefehle `?action=create|join` (docs/10): Fokus aufs passende Feld */
  focus?: "create" | "join" | null;
}

/**
 * Startseite (docs/09 §6): Wortmarke, Claim, Name (aus localStorage vorbefüllt), „Lobby erstellen“,
 * „oder“, Lobby-Code mit Auto-Beitritt bei 6 Zeichen, „Beitreten“, Footer-Link „Regeln“.
 * Impressum/Datenschutz bleiben bis zum Umzug auf eine eigene Domain weg (ADR-030).
 * PWA (docs/10): oben das Update-Banner (neue Version oder `UPDATE_REQUIRED`), über dem Footer die Zeile
 * „Als App installieren“ (nur nach dem ersten beendeten Spiel und wenn installierbar).
 */
export function StartScreen({ realtimeUrl, focus = null }: StartScreenProps) {
  const router = useRouter();
  const nameRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);
  // Allgemeine Fehler inline unter der jeweiligen Aktion (kein Toast: hält das Start-Bundle ohne Animationen).
  const [formError, setFormError] = useState<{ at: "create" | "join"; text: string } | null>(null);
  const [busy, setBusy] = useState<"create" | "join" | null>(null);
  const [updateRequired, setUpdateRequired] = useState(false);

  useEffect(() => {
    const stored = readStoredName();
    if (stored) setName((current) => current || stored);
    if (focus === "join") codeRef.current?.focus();
    else if (focus === "create") nameRef.current?.focus();
  }, [focus]);

  const showError = (errorCode: ClientErrorCode, placement: ErrorPlacement, at: "create" | "join") => {
    if (placement === "name") {
      setNameError(errorText(errorCode));
      nameRef.current?.focus();
    } else if (placement === "code") {
      setCodeError(errorText(errorCode));
    } else if (placement === "banner") {
      setUpdateRequired(true);
    } else {
      setFormError({ at, text: errorText(errorCode) });
    }
  };

  /** Name prüfen (nur „nicht leer“ – die Regeln prüft der Server → NAME_REJECTED) und merken. */
  const requireName = (): string | null => {
    const trimmed = name.trim();
    if (!trimmed) {
      setNameError(de.start.nameRequired);
      nameRef.current?.focus();
      return null;
    }
    setNameError(null);
    writeStoredName(trimmed);
    return trimmed;
  };

  const run = async (
    kind: "create" | "join",
    action: (
      client: RealtimeClient,
    ) => Promise<{ ok: true; data: { code: string } } | { ok: false; code: ClientErrorCode }>,
    placement: (errorCode: ClientErrorCode) => ErrorPlacement,
  ) => {
    setBusy(kind);
    setFormError(null);
    let client: RealtimeClient;
    try {
      client = await loadRealtimeClient(realtimeUrl);
    } catch (error) {
      console.error("Realtime-Client konnte nicht geladen werden:", error instanceof Error ? error.name : "unbekannt");
      setBusy(null);
      showError("NETWORK", "toast", kind);
      return;
    }
    const result = await action(client);
    if (result.ok) {
      // Bleibt „busy“, bis die Lobby-Seite da ist (kein zweiter Klick).
      router.push(lobbyPath(result.data.code));
      return;
    }
    setBusy(null);
    showError(result.code, placement(result.code), kind);
  };

  const create = (event?: FormEvent) => {
    event?.preventDefault();
    if (busy) return;
    const trimmed = requireName();
    if (!trimmed) return;
    void run("create", (client) => client.createLobby(trimmed), createErrorPlacement);
  };

  const join = (value: string) => {
    if (busy) return;
    if (value.length < LOBBY_CODE_LENGTH) {
      setCodeError(de.start.codeIncomplete);
      codeRef.current?.focus();
      return;
    }
    const trimmed = requireName();
    if (!trimmed) return;
    setCodeError(null);
    void run("join", (client) => client.joinLobby(value, trimmed), joinErrorPlacement);
  };

  return (
    // Safe Area oben am äußeren Rahmen: Das Update-Banner steht unter der (durchscheinenden) Statusleiste.
    <div className="flex min-h-dvh flex-col pt-safe">
      <UpdateBanner required={updateRequired} />
      <main className="mx-auto flex w-full max-w-column flex-1 flex-col px-gutter">
        <div className="flex flex-1 flex-col justify-center gap-8 py-10">
          <header className="flex flex-col gap-2">
            <h1 className="text-wordmark text-text">
              {de.app.name}
              <span aria-hidden="true" className="ml-1 inline-block size-2.5 bg-primary" />
            </h1>
            <p className="text-body text-text-2">{de.app.claim}</p>
          </header>

          <form noValidate onSubmit={create} className="flex flex-col gap-4">
            <TextField
              ref={nameRef}
              label={de.fields.name}
              value={name}
              error={nameError}
              onChange={(event) => {
                setName(event.target.value);
                setNameError(null);
              }}
              onFocus={warmUpRealtimeClient}
              name="name"
              autoComplete="nickname"
              autoCapitalize="words"
              enterKeyHint="go"
              maxLength={NAME_MAX_LENGTH}
              data-testid="start-name"
            />
            <Button type="submit" variant="primary" block loading={busy === "create"} data-testid="start-create">
              {de.actions.createLobby}
            </Button>
            <FormError message={formError?.at === "create" ? formError.text : null} testId="start-create-error" />
          </form>

          <div className="flex items-center gap-3">
            <span aria-hidden="true" className="h-px flex-1 bg-line" />
            <span className="text-caption text-text-3">{de.start.or}</span>
            <span aria-hidden="true" className="h-px flex-1 bg-line" />
          </div>

          <div className="flex flex-col gap-4">
            <CodeInput
              ref={codeRef}
              value={code}
              onChange={(value) => {
                setCode(value);
                setCodeError(null);
                if (value.length > 0) warmUpRealtimeClient();
              }}
              onComplete={join}
              hint={de.fields.lobbyCodeHint}
              error={codeError}
              disabled={busy !== null}
              name="code"
            />
            <Button
              variant="secondary"
              block
              loading={busy === "join"}
              onClick={() => join(code)}
              data-testid="start-join"
            >
              {de.actions.join}
            </Button>
            <FormError message={formError?.at === "join" ? formError.text : null} testId="start-join-error" />
          </div>
        </div>

        <InstallRow />
        <footer className="flex justify-center pt-4 pb-safe">
          <Link
            href="/regeln"
            prefetch={false}
            className="rounded-sm text-caption text-text-3 underline underline-offset-4"
          >
            {de.start.rules}
          </Link>
        </footer>
      </main>
    </div>
  );
}
