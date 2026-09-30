// Caddy-Site für quizmaster (Aufruf aus infra/caddy/install-site.sh):
//
//   node scripts/ops/caddy-site.ts refresh-ips --ips-file <gespeichert> --out <neu>
//     Cloudflare-Listen holen und prüfen. Ausgabe: STATUS=changed|unchanged|failed (+ Zähler).
//     Nur bei „changed“ wird --out geschrieben; die gespeicherte Datei bleibt unangetastet.
//   node scripts/ops/caddy-site.ts render --env-file .env.prod --template <t> --ips-file <f> --out <site>
//     Site-Datei rendern. Ausgabe: DOMAIN=…, WEB_PORT=…, REALTIME_PORT=…, TLS_CERT_FILE=…, TLS_KEY_FILE=…
//
// Domain und Ports kommen über resolveEnv (Realtime-Port = Port + 1, falls leer) – dieselbe Ableitung wie
// bei Apps und Deploy. Ausgegeben werden nur nicht-geheime Werte.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { resolveEnv } from "@quizmaster/shared/env";
import { renderSite } from "./lib/caddy.ts";
import { fetchLists, parseIpFile, sameLists, serializeIpFile, validateLists } from "./lib/cloudflare.ts";
import { loadEnv, OpsError } from "./lib/env.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "env-file": { type: "string" },
    template: { type: "string" },
    "ips-file": { type: "string" },
    out: { type: "string" },
  },
});

function required(name: "env-file" | "template" | "ips-file" | "out"): string {
  const value = values[name];
  if (!value) throw new OpsError(`--${name} fehlt`);
  return resolve(value);
}

/** Heutiges Datum in Serverzeit (YYYY-MM-DD). */
function today(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

async function refreshIps(): Promise<void> {
  const savedPath = required("ips-file");
  const out = required("out");
  const saved = parseIpFile(readFileSync(savedPath, "utf8"));
  let fetched: Awaited<ReturnType<typeof fetchLists>>;
  try {
    fetched = await fetchLists();
  } catch (error) {
    console.log("STATUS=failed");
    console.error(`caddy-site – Cloudflare-Listen nicht abrufbar: ${error instanceof Error ? error.message : error}`);
    return;
  }
  const problems = validateLists(fetched);
  if (problems.length > 0) {
    console.log("STATUS=failed");
    console.error(`caddy-site – Cloudflare-Listen unplausibel: ${problems.join("; ")}`);
    return;
  }
  console.log(`V4_COUNT=${fetched.v4.length}`);
  console.log(`V6_COUNT=${fetched.v6.length}`);
  if (sameLists(saved, fetched)) {
    console.log("STATUS=unchanged");
    return;
  }
  writeFileSync(out, serializeIpFile(fetched, today()), { mode: 0o644 });
  console.log("STATUS=changed");
}

function render(): void {
  const env = loadEnv(required("env-file"));
  const template = readFileSync(required("template"), "utf8");
  const ips = parseIpFile(readFileSync(required("ips-file"), "utf8"));
  const problems = validateLists(ips);
  if (problems.length > 0) throw new OpsError(`IP-Liste unplausibel: ${problems.join("; ")}`);
  const resolved = resolveEnv(env, "prod");
  if (!resolved.domain) throw new OpsError("QUIZMASTER_DOMAIN fehlt");
  if (!env.TLS_CERT_FILE || !env.TLS_KEY_FILE) throw new OpsError("TLS_CERT_FILE und TLS_KEY_FILE fehlen");
  const stand = /Stand: (\d{4}-\d{2}-\d{2})/.exec(readFileSync(required("ips-file"), "utf8"))?.[1] ?? "unbekannt";
  const site = renderSite(template, {
    domain: resolved.domain,
    webPort: resolved.webPort,
    realtimePort: resolved.realtimePort,
    certFile: env.TLS_CERT_FILE,
    keyFile: env.TLS_KEY_FILE,
    cloudflareIps: [...ips.v4, ...ips.v6],
    ipsNote: `Cloudflare-IP-Bereiche: ${ips.v4.length} IPv4 + ${ips.v6.length} IPv6 (Stand ${stand})`,
  });
  writeFileSync(required("out"), site, { mode: 0o644 });
  console.log(`DOMAIN=${resolved.domain}`);
  console.log(`WEB_PORT=${resolved.webPort}`);
  console.log(`REALTIME_PORT=${resolved.realtimePort}`);
  console.log(`TLS_CERT_FILE=${env.TLS_CERT_FILE}`);
  console.log(`TLS_KEY_FILE=${env.TLS_KEY_FILE}`);
  console.log(`IPS_COUNT=${ips.v4.length + ips.v6.length}`);
}

async function main(): Promise<void> {
  const command = positionals[0];
  if (command === "refresh-ips") await refreshIps();
  else if (command === "render") render();
  else throw new OpsError("Aufruf: caddy-site.ts refresh-ips|render …");
}

main().catch((error: unknown) => {
  console.error(`caddy-site – ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
