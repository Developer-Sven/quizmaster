// pm2-Prozessdefinition für quizmaster (ADR-024). CommonJS, weil das Root-package.json kein "type": "module" hat.
//
// Benutzt von `pnpm deploy:prod`, `pnpm deploy:rollback` und `pnpm deploy:restart` (scripts/deploy): sie rufen
// `pm2 startOrReload ecosystem.config.js --only <app>` mit bereinigter Umgebung auf. Alle Pfade hängen an
// __dirname – Domain und Ports kommen ausschließlich aus .env.prod (über die erzeugten Env-Dateien):
//   .deploy/current          Symlink auf das aktive Release (.deploy/releases/<sha>); pm2 speichert den
//                            Symlink-Pfad, ein Neustart nach dem Umhängen startet also das neue Release
//   .deploy/runtime/node     verifizierte Node-24-Kopie aus .tooling (System-Node bleibt Version 22)
//   .deploy/env/<app>.env    nur die Schlüssel der App (webProcessEnv/realtimeProcessEnv/watchdogProcessEnv);
//                            mit Dienstbenutzer 640 root:quizmaster (Verzeichnis 750), ohne 600 root
//
// Benutzer: Existiert der Systembenutzer `quizmaster` (infra/ops/create-user.sh), startet der pm2-Daemon (root)
// alle drei Apps mit dessen uid/gid (docs/12 „Nicht-Root-User“, README „Systembenutzer“); sonst wie vor der
// Umstellung als root – der Deploy-Preflight warnt dann. Aufgelöst wird über /etc/passwd und /etc/group
// (scripts/deploy/service-user.cjs, gemeinsam mit dem Deploy-Werkzeug); uid/gid 0, eine nicht exklusive Gruppe
// oder unlesbare Kataloge brechen ab, statt still als root zu starten.
//
// Secrets stehen nie hier, nie in `env` und nie in dump.pm2: Node liest sie beim Start selbst (`--env-file`).
// `filter_env: [""]` hält die Umgebung der aufrufenden Shell von den Apps fern – Werte wie HOSTNAME, PORT oder
// NODE_OPTIONS hätten sonst Vorrang vor der Env-Datei (`--env-file` überschreibt keine gesetzten Variablen).
// `filter_env: true` ist in pm2 6.0.x wirkungslos (geprüft); das leere Muster passt auf jeden Schlüssel.
// Achtung: `pm2 restart <app> --update-env` übernimmt die Shell-Umgebung trotzdem – stattdessen
// `pnpm deploy:restart` benutzen.

const path = require("node:path");
const { readServiceIdentity, SERVICE_USER } = require("./scripts/deploy/service-user.cjs");

/**
 * `.deploy` der Produktion. Nur Tests des Deploy-Werkzeugs (`--test-env`, eigener pm2-Daemon) setzen
 * `QM_DEPLOY_DIR` – erlaubt ist ausschließlich `<repo>/.deploy/test`, damit ein Test nie `current` oder die
 * Env-Dateien der Produktion berührt. Jeder andere Wert bricht ab.
 */
function resolveDeployDir() {
  const production = path.join(__dirname, ".deploy");
  const override = process.env.QM_DEPLOY_DIR;
  if (!override) return production;
  const testDir = path.join(production, "test");
  if (path.resolve(override) !== testDir) {
    throw new Error(`QM_DEPLOY_DIR ist nur als ${testDir} erlaubt (Tests des Deploy-Werkzeugs)`);
  }
  return testDir;
}

const deployDir = resolveDeployDir();
const current = path.join(deployDir, "current");
const interpreter = path.join(deployDir, "runtime", "node", "bin", "node");

/**
 * Benutzer der Apps: `quizmaster`, falls vorhanden, sonst root (Rückfall). Nur Tests des Deploy-Werkzeugs
 * (`--test-user`, Layout `.deploy/test`, eigener pm2-Daemon) wählen über `QM_SERVICE_USER` einen anderen,
 * vorhandenen Benutzer, z. B. nobody – dessen Gruppe darf dort mit anderen Konten geteilt sein.
 */
function resolveIdentity() {
  const requested = process.env.QM_SERVICE_USER;
  if (requested === undefined || requested === "") {
    return readServiceIdentity({ user: SERVICE_USER, required: false, allowSharedGroup: false });
  }
  if (deployDir !== path.join(__dirname, ".deploy", "test")) {
    throw new Error("QM_SERVICE_USER ist nur für Tests des Deploy-Werkzeugs erlaubt (QM_DEPLOY_DIR=.deploy/test)");
  }
  return readServiceIdentity({ user: requested, required: true, allowSharedGroup: true });
}

const identity = resolveIdentity();
const SYSTEM_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/** `--env-file=<abs>/.deploy/env/<app>.env` (absolut, damit der Pfad nicht vom Arbeitsverzeichnis abhängt). */
const envFile = (app) => `--env-file=${path.join(deployDir, "env", `${app}.env`)}`;

const common = {
  namespace: "quizmaster",
  exec_mode: "fork",
  instances: 1,
  interpreter,
  // Immer numerisch und immer gesetzt: pm2 übernimmt bei startOrReload nur vorhandene Schlüssel in den
  // gespeicherten Prozess – 0 (= Benutzer des Daemons, root) setzt daher eine früher gespeicherte uid zurück,
  // wenn der Dienstbenutzer wieder entfernt wurde (README „Systembenutzer“, Rückweg). pm2 setzt uid/gid beim
  // Start (spawn) und verwirft dabei alle Zusatzgruppen des Daemons.
  uid: identity.uid,
  gid: identity.gid,
  autorestart: true,
  // Absturz innerhalb von 10 s gilt als instabil; nach 30 solchen Neustarts (in den ersten 5 min) → errored.
  min_uptime: 10_000,
  max_restarts: 30,
  // Neustarts mit wachsender Pause (200 ms … 15 s), zurückgesetzt nach stabiler Laufzeit.
  exp_backoff_restart_delay: 200,
  merge_logs: true,
  filter_env: [""],
  // HOME des Dienstbenutzers (wie pm2 es beim Erststart setzt) auch bei Neustarts – nie /root aus dem Aufrufer.
  env: identity.kind === "service" ? { PATH: SYSTEM_PATH, HOME: identity.home } : { PATH: SYSTEM_PATH },
  // Kein @pm2/io, kein Git-Scan, keine eigene Source-Map-Unterstützung von pm2 im App-Prozess.
  pmx: false,
  vizion: false,
  automation: false,
  disable_source_map_support: true,
};

module.exports = {
  apps: [
    {
      ...common,
      name: "quizmaster-web",
      // Next.js standalone (Monorepo: server.js liegt unter apps/web)
      cwd: path.join(current, "web", "apps", "web"),
      script: "server.js",
      interpreter_args: [envFile("web")],
      max_memory_restart: "768M",
      kill_timeout: 10_000,
    },
    {
      ...common,
      name: "quizmaster-realtime",
      // tsdown-Bundle; sendet process.send("ready") nach listen und fährt bei SIGINT/SIGTERM sauber herunter
      cwd: path.join(current, "realtime"),
      script: "dist/index.mjs",
      interpreter_args: [envFile("realtime"), "--enable-source-maps"],
      // Lasttest (docs/perf-report.md): ≈ 57 KB RSS je Verbindung → MAX_CONNECTIONS 20.000 ≈ 1,4 GB; Reserve, damit pm2
      // einen gesunden, nur ausgelasteten Prozess nicht neu startet (das würde alle laufenden Spiele unterbrechen).
      max_memory_restart: "2560M",
      wait_ready: true,
      listen_timeout: 20_000,
      kill_timeout: 15_000,
    },
    {
      ...common,
      name: "quizmaster-watchdog",
      // Wird nur gestartet, wenn das Release dist/watchdog.mjs enthält (prüft der Deploy).
      cwd: path.join(current, "realtime"),
      script: "dist/watchdog.mjs",
      interpreter_args: [envFile("watchdog"), "--enable-source-maps"],
      max_memory_restart: "128M",
      kill_timeout: 5_000,
    },
  ],
};
