"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { AppHeader, HeaderTitle } from "@/components/app/app-header";
import { AppShell } from "@/components/app/app-shell";
import { FormError } from "@/components/app/form-error";
import { type TurnstileClientConfig, TurnstileSlot, useTurnstile } from "@/components/turnstile/turnstile-slot";
import { Banner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { TextField } from "@/components/ui/text-field";
import { de } from "@/i18n/de";
import { type ClientErrorCode, errorText, joinErrorPlacement } from "@/lib/client/errors";
import { loadRealtimeClient, warmUpRealtimeClient } from "@/lib/client/load-realtime";
import { lobbyPath } from "@/lib/client/paths";
import type { RealtimeClient } from "@/lib/client/realtime-client";
import { reloadPage } from "@/lib/client/reload";
import { readStoredName, writeStoredName } from "@/lib/client/storage";
import type { MaintenanceNotice } from "@/lib/server/maintenance";
import { ChevronLeftIcon } from "@/lib/ui/icons";

const NAME_MAX_LENGTH = 64;
const FORM_ID = "join-form";

export interface JoinScreenProps {
  /** normalisierter, gültiger Code */
  code: string;
  /** Anzeige „ABC 234“ */
  displayCode: string;
  realtimeUrl: string;
  /** Turnstile aus der Laufzeit-Konfiguration (docs/06 §Bot-Schutz) */
  turnstile: TurnstileClientConfig;
  /** Serverseitig ermittelter Wartungshinweis; `null` = keiner */
  maintenance?: MaintenanceNotice | null;
}

/**
 * Beitreten per Link/QR (`/j/[code]`, docs/09 §6): Code steht fest, nur Name + „Beitreten“.
 * Lobby-Fehler (nicht gefunden, voll, läuft bereits, entfernt) erscheinen inline unter dem Code. Banner: Update vor
 * Wartung (docs/09 §5). Turnstile (docs/06) läuft beim Anlegen der Session bzw. nach `TURNSTILE_REQUIRED`.
 */
export function JoinScreen({ code, displayCode, realtimeUrl, turnstile, maintenance = null }: JoinScreenProps) {
  const router = useRouter();
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);
  // Allgemeine Fehler inline unter dem Namen (kein Toast: hält die Seite ohne Animations-Code).
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [updateRequired, setUpdateRequired] = useState(false);
  const solver = useTurnstile(turnstile);
  const clientRef = useRef<RealtimeClient | null>(null);

  // Den Turnstile-Anbieter dieser Seite beim Verlassen abmelden (der Realtime-Client lebt seitenübergreifend).
  useEffect(() => () => clientRef.current?.setTurnstileProvider(null), []);

  useEffect(() => {
    const stored = readStoredName();
    if (stored) setName((current) => current || stored);
  }, []);

  const showError = (errorCode: ClientErrorCode) => {
    const placement = joinErrorPlacement(errorCode);
    if (placement === "code") setCodeError(errorText(errorCode));
    else if (placement === "name") {
      setNameError(errorText(errorCode));
      nameRef.current?.focus();
    } else if (placement === "banner") setUpdateRequired(true);
    else setFormError(errorText(errorCode));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setNameError(de.start.nameRequired);
      nameRef.current?.focus();
      return;
    }
    setNameError(null);
    setCodeError(null);
    setFormError(null);
    writeStoredName(trimmed);
    setBusy(true);
    let client: RealtimeClient;
    try {
      client = await loadRealtimeClient(realtimeUrl);
    } catch (error) {
      console.error("Realtime-Client konnte nicht geladen werden:", error instanceof Error ? error.name : "unbekannt");
      setBusy(false);
      showError("NETWORK");
      return;
    }
    clientRef.current = client;
    client.setTurnstileProvider(solver === null ? null : (purpose) => solver.solve(purpose), {
      sessionRequiresToken: turnstile.enabled,
    });
    const result = await client.joinLobby(code, trimmed);
    if (result.ok) {
      router.replace(lobbyPath(result.data.code));
      return;
    }
    setBusy(false);
    // Turnstile gescheitert: Den Fehler zeigt die Prüfung selbst (ohne Widget: allgemeiner Turnstile-Hinweis).
    if (result.code === "TURNSTILE_REQUIRED") {
      if (solver === null) setFormError(de.turnstile.failed);
      return;
    }
    showError(result.code);
  };

  return (
    <AppShell
      testId="join-screen"
      header={
        <AppHeader
          left={<IconButton icon={ChevronLeftIcon} label={de.actions.back} onClick={() => router.push("/")} />}
          title={<HeaderTitle>{de.actions.join}</HeaderTitle>}
        />
      }
      banner={
        updateRequired ? (
          <Banner tone="update" onAction={reloadPage} />
        ) : maintenance !== null ? (
          <div data-testid="maintenance-banner">
            <Banner tone="maintenance" message={de.maintenance.message(maintenance.message)} />
          </div>
        ) : null
      }
      actions={
        <Button type="submit" form={FORM_ID} variant="primary" block loading={busy} data-testid="join-submit">
          {de.actions.join}
        </Button>
      }
    >
      <div className="flex flex-col gap-8">
        <div className="flex flex-col gap-2">
          <span className="text-label text-text">{de.fields.lobbyCode}</span>
          <p data-testid="join-code" className="text-display tracking-code text-text tabular-nums">
            {displayCode}
          </p>
          <FormError message={codeError} testId="join-error" />
        </div>
        <form id={FORM_ID} noValidate onSubmit={submit} className="flex flex-col gap-4">
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
            data-testid="join-name"
          />
          <FormError message={formError} testId="join-form-error" />
          <TurnstileSlot solver={solver} />
        </form>
      </div>
    </AppShell>
  );
}
