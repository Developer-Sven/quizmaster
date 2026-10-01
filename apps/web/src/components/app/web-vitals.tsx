"use client";

import { useReportWebVitals } from "next/web-vitals";

type ReportWebVitalsCallback = Parameters<typeof useReportWebVitals>[0];

/** Schon gemeldete Messwerte: StrictMode hängt den Hook in Entwicklung zweimal ein, web-vitals meldet dann doppelt. */
const reported = new Set<string>();

/** Feste Funktionsreferenz (sonst meldet der Hook bei jedem Rendern erneut, Next-Doku). */
const logWebVitals: ReportWebVitalsCallback = (metric) => {
  // Jede Registrierung vergibt eigene IDs – Name und Wert erkennen die Doppelmeldung.
  const key = `${metric.name}:${metric.value}`;
  if (reported.has(key)) return;
  reported.add(key);
  const value = metric.name === "CLS" ? metric.value.toFixed(3) : `${Math.round(metric.value)} ms`;
  console.info(`[web-vitals] ${metric.name} ${value} (${metric.rating})`);
};

/**
 * Web Vitals nur in der Entwicklung (ADR-027, docs/07 §SLOs: LCP, INP, CLS): Messwerte landen in der
 * Browser-Konsole, kein Tracking-Dienst, kein Endpoint. Das Wurzel-Layout bindet die Komponente nur bei
 * `NODE_ENV === "development"` ein – im Produktions-Build wird sie samt `next/web-vitals` nicht gebündelt
 * (Nachweis: `pnpm perf:budgets`, Chunks ohne „web-vitals“). In Produktion belegen Lighthouse-Läufe
 * (`pnpm perf:lighthouse`) LCP, CLS und TBT als Labor-Ersatz für INP.
 */
export function WebVitals() {
  useReportWebVitals(logWebVitals);
  return null;
}
