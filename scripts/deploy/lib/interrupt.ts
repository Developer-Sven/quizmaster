/**
 * Abbruch-Steuerung des Deploy-Werkzeugs (ADR-025). SIGINT (Strg+C), SIGTERM und SIGHUP (SSH-/Terminal-
 * abbruch) werden nur vorgemerkt: der laufende Schritt endet sauber, vor der Aktivierung bricht der Deploy an
 * der nächsten Prüfstelle (`checkpoint`) ab. Ohne eigenen Handler beendet Node einen Prozess bei SIGHUP sofort
 * (Exit 129) – mitten in der Aktivierung, ohne Rückweg, ohne state.json und mit liegengebliebener Sperre.
 *
 * Ein zweites Strg+C bzw. SIGTERM beendet sofort – außer in einem kritischen Abschnitt (Aktivierung, Rückweg,
 * state.json, `pm2 save`): dort wird es nur gemeldet, das Werkzeug endet erst danach. Wiederholte SIGHUP
 * (Kernel und Shell senden es beim Verbindungsabbruch oft beide) erzwingen nie ein Ende. Notfall: `kill -9`.
 */
import { constants } from "node:os";
import { DeployError, fail, warn } from "./log.ts";

export const HANDLED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
export type HandledSignal = (typeof HANDLED_SIGNALS)[number];

export interface InterruptReporter {
  warn(message: string): void;
  fail(message: string): void;
}

export interface InterruptOptions {
  /** Sofortiges Ende beim zweiten Abbruch außerhalb eines kritischen Abschnitts (Standard: process.exit). */
  exit?: (code: number) => void;
  /** Meldungen (Standard: warn/fail aus log.ts). */
  report?: InterruptReporter;
}

export interface Interrupts {
  /** Erstes empfangenes Signal oder null. */
  readonly signal: HandledSignal | null;
  /** Exit-Code für einen vorgemerkten Abbruch (128 + Signalnummer) oder null. */
  exitCode(): number | null;
  /** Prüfstelle (nur vor der Aktivierung): wirft DeployError("INTERRUPTED"), falls ein Abbruch vorgemerkt ist. */
  checkpoint(message: string): void;
  /** Kritischer Abschnitt: weitere Signale beenden das Werkzeug erst, wenn `fn` fertig ist. */
  critical<T>(fn: () => Promise<T>): Promise<T>;
  /** Handler wieder entfernen. */
  dispose(): void;
}

/** Exit-Code nach Shell-Konvention: 128 + Signalnummer (SIGHUP 129, SIGINT 130, SIGTERM 143). */
export function signalExitCode(signal: HandledSignal): number {
  return 128 + constants.signals[signal];
}

export function installInterrupts(options: InterruptOptions = {}): Interrupts {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const report = options.report ?? { warn, fail };
  let first: HandledSignal | null = null;
  let depth = 0;

  const onSignal = (signal: HandledSignal) => {
    if (first === null) {
      first = signal;
      report.warn(
        signal === "SIGHUP"
          ? "Terminal getrennt (SIGHUP) – Abbruch vorgemerkt: vor der Aktivierung wird abgebrochen, eine " +
              "laufende Aktivierung (inkl. Rückweg) wird zu Ende geführt. Ergebnis: pnpm deploy:status"
          : `Abbruch angefordert (${signal}) – der laufende Schritt wird sauber beendet` +
              (depth > 0 ? "; die Aktivierung läuft zu Ende" : " (erneut drücken erzwingt das Ende)"),
      );
      return;
    }
    if (signal === "SIGHUP") return;
    if (depth > 0) {
      report.warn(
        `${signal}: Aktivierung läuft – Abbruch erst nach Abschluss bzw. Rückweg möglich ` +
          `(Notfall: kill -9 ${process.pid}, danach pnpm deploy:status)`,
      );
      return;
    }
    report.fail("zweiter Abbruch – sofortiges Ende; Zustand prüfen: pnpm deploy:status");
    exit(signalExitCode(first));
  };

  const handlers = HANDLED_SIGNALS.map((signal) => {
    const handler = () => onSignal(signal);
    process.on(signal, handler);
    return [signal, handler] as const;
  });

  return {
    get signal() {
      return first;
    },
    exitCode() {
      return first === null ? null : signalExitCode(first);
    },
    checkpoint(message) {
      if (first !== null) throw new DeployError("INTERRUPTED", message);
    },
    async critical(fn) {
      depth += 1;
      try {
        return await fn();
      } finally {
        depth -= 1;
      }
    },
    dispose() {
      for (const [signal, handler] of handlers) process.off(signal, handler);
    },
  };
}
