"use client";

import { useEffect } from "react";
import { startInstallCapture } from "./install-state";
import { startServiceWorker } from "./service-worker";

/**
 * PWA-Laufzeit im Root-Layout (docs/10): registriert den Service Worker samt Update-Fluss und fängt
 * `beforeinstallprompt` so früh wie möglich ab (das Event kommt nur einmal je Seitenaufruf). Rendert nichts.
 */
export function PwaRegistrar() {
  useEffect(() => {
    const stopInstallCapture = startInstallCapture(window);
    const stopServiceWorker = startServiceWorker();
    return () => {
      stopInstallCapture();
      stopServiceWorker();
    };
  }, []);
  return null;
}
