/** Kleine Hilfen für asynchrone Abläufe mit Frist. */

export class TimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(label: string, timeoutMs: number) {
    super(`${label}: keine Antwort innerhalb von ${timeoutMs} ms`);
    this.name = "TimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Wartet höchstens `ms` auf `promise` und wirft sonst `TimeoutError`. Eine spätere Ablehnung von `promise`
 * bleibt behandelt (keine unbehandelte Promise-Ablehnung).
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
