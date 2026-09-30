/** Deutsche Zahlen- und Datumsformate für Ausgaben und STATUS.md. */

const integerFormat = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 });
const dateFormat = new Intl.DateTimeFormat("de-DE", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  timeZone: "Europe/Berlin",
});

/** 22472 → „22.472“ */
export function formatInt(value: number): string {
  return integerFormat.format(value);
}

/** Anteil als ganze Prozent („18 %“); 0 bei leerer Basis. */
export function formatPercent(count: number, total: number): string {
  return `${total === 0 ? 0 : Math.round((count / total) * 100)} %`;
}

/** „30.09.2026“ (Europe/Berlin). */
export function formatDate(date: Date): string {
  return dateFormat.format(date);
}
