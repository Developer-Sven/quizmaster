// Alarm an ALERT_WEBHOOK_URL (Discord- und Slack-kompatibel: {"content": …, "text": …}) – Aufruf über
// infra/ops/alert.sh. Ohne URL wird nur geloggt (Exit 0). Die URL wird nie ausgegeben.
//
//   node scripts/ops/alert.ts --env-file .env.prod -- "Backup fehlgeschlagen: …"
import { hostname } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { alertPayload } from "./lib/alert.ts";
import { loadEnv, OpsError } from "./lib/env.ts";

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { "env-file": { type: "string" } },
  });
  const message = positionals.join(" ").trim();
  if (!values["env-file"] || message === "") throw new OpsError("Aufruf: alert.ts --env-file <datei> -- <nachricht>");
  const env = loadEnv(resolve(values["env-file"]));
  const url = env.ALERT_WEBHOOK_URL;
  if (!url) {
    console.log("alert – keine ALERT_WEBHOOK_URL gesetzt: nur Log");
    return;
  }
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(alertPayload(message, hostname())),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    // Nur Fehlerart/-code, nie die URL (enthält das Webhook-Token).
    const code = (error as { cause?: { code?: unknown } }).cause?.code;
    const reason = typeof code === "string" ? code : error instanceof Error ? error.name : "Fehler";
    throw new OpsError(`Webhook nicht erreichbar (${reason})`);
  }
  if (!response.ok) throw new OpsError(`Webhook antwortet mit HTTP ${response.status}`);
  console.log(`alert – gesendet (HTTP ${response.status})`);
}

main().catch((error: unknown) => {
  console.error(`alert – ${error instanceof OpsError ? error.message : "unerwarteter Fehler"}`);
  process.exit(1);
});
