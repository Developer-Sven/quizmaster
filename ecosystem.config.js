// pm2-Prozessdefinition für quizmaster (ADR-024). CommonJS, weil das Root-package.json kein "type": "module" hat.
//
// Benutzt von `pnpm deploy:prod`, `pnpm deploy:rollback` und `pnpm deploy:restart` (scripts/deploy): sie rufen
// `pm2 startOrReload ecosystem.config.js --only <app>` mit bereinigter Umgebung auf. Alle Pfade hängen an
// __dirname – Domain und Ports kommen ausschließlich aus .env.prod (über die erzeugten Env-Dateien):
//   .deploy/current          Symlink auf das aktive Release (.deploy/releases/<sha>); pm2 speichert den
//                            Symlink-Pfad, ein Neustart nach dem Umhängen startet also das neue Release
//   .deploy/runtime/node     verifizierte Node-24-Kopie aus .tooling (System-Node bleibt Version 22)
//   .deploy/env/<app>.env    nur die Schlüssel der App (webProcessEnv/realtimeProcessEnv/watchdogProcessEnv), 600
//
// Secrets stehen nie hier, nie in `env` und nie in dump.pm2: Node liest sie beim Start selbst (`--env-file`).
// `filter_env: [""]` hält die Umgebung der aufrufenden Shell von den Apps fern – Werte wie HOSTNAME, PORT oder
// NODE_OPTIONS hätten sonst Vorrang vor der Env-Datei (`--env-file` überschreibt keine gesetzten Variablen).
// `filter_env: true` ist in pm2 6.0.x wirkungslos (geprüft); das leere Muster passt auf jeden Schlüssel.
// Achtung: `pm2 restart <app> --update-env` übernimmt die Shell-Umgebung trotzdem – stattdessen
// `pnpm deploy:restart` benutzen.

const path = require("node:path");

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

/** `--env-file=<abs>/.deploy/env/<app>.env` (absolut, damit der Pfad nicht vom Arbeitsverzeichnis abhängt). */
const envFile = (app) => `--env-file=${path.join(deployDir, "env", `${app}.env`)}`;

// Restrisiko: Die Apps laufen – wie alle Apps dieses Servers – als root (pm2-root.service, kein uid/gid);
// docs/12 sah einen Nicht-Root-Benutzer vor. Umstellung (Systembenutzer, uid/gid je App, Rechte unter .deploy)
// steht in README „Vor dem Go-live offen“ und braucht eine Entscheidung des Betreibers.
const common = {
  namespace: "quizmaster",
  exec_mode: "fork",
  instances: 1,
  interpreter,
  autorestart: true,
  // Absturz innerhalb von 10 s gilt als instabil; nach 30 solchen Neustarts (in den ersten 5 min) → errored.
  min_uptime: 10_000,
  max_restarts: 30,
  // Neustarts mit wachsender Pause (200 ms … 15 s), zurückgesetzt nach stabiler Laufzeit.
  exp_backoff_restart_delay: 200,
  merge_logs: true,
  filter_env: [""],
  env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" },
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
      max_memory_restart: "1536M",
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
