/**
 * Anleitung zum Installieren (ADR-054) – nur, wo der Browser nicht selbst installieren kann: auf iPhone/iPad (jeder
 * Browser, über „Teilen“ → „Zum Home-Bildschirm“) und auf Android ohne Installationsdialog (z. B. Firefox, über das
 * Browser-Menü). Drei kurze Schritte, passend zum Browser.
 */
import { de } from "../../i18n/de";
import type { InstallBrowser } from "./install-state";

/** Symbol eines Schritts: „Teilen“ (iOS), Browser-Menü (Android), „Hinzufügen“ – `null` ohne Symbol. */
export type InstallStepIcon = "share" | "menu" | "add";

export interface InstallStep {
  text: string;
  icon: InstallStepIcon | null;
}

function iosShareStep(browser: InstallBrowser): string {
  const steps = de.pwa.installSteps;
  switch (browser) {
    case "safari":
      return steps.iosShareSafari;
    case "chrome":
      return steps.iosShareChrome;
    case "firefox":
      return steps.iosShareFirefox;
    default:
      return steps.iosShareOther;
  }
}

/** Schritte für `method` und `browser`. */
export function installSteps(method: "ios" | "android", browser: InstallBrowser): InstallStep[] {
  const steps = de.pwa.installSteps;
  if (method === "ios") {
    return [
      { text: iosShareStep(browser), icon: "share" },
      { text: steps.iosAdd, icon: "add" },
      { text: steps.iosConfirm, icon: null },
    ];
  }
  // Samsung Internet öffnet sein Menü über ≡ unten rechts – dafür gibt es kein Icon in docs/09 §9, und `⋮` wäre
  // falsch: Der Schritt nennt nur den Ort, ohne Symbol.
  const menu: InstallStep =
    browser === "firefox"
      ? { text: steps.androidMenuFirefox, icon: "menu" }
      : browser === "samsung"
        ? { text: steps.androidMenuSamsung, icon: null }
        : { text: steps.androidMenu, icon: "menu" };
  const add =
    browser === "firefox"
      ? steps.androidAddFirefox
      : browser === "samsung"
        ? steps.androidAddSamsung
        : steps.androidAdd;
  return [menu, { text: add, icon: "add" }, { text: steps.androidConfirm, icon: null }];
}
