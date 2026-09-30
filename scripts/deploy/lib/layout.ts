/**
 * Verzeichnislayout des Releases auf dem Server (ADR-025) – gleiche Pfade wie in `ecosystem.config.js`:
 *
 * .deploy/                      (700, gitignored)
 *   runtime/node -> node-v24…   verifizierte Node-24-Kopie aus .tooling (pm2-Interpreter)
 *   releases/<sha>/{web,realtime}
 *   current -> releases/<sha>   aktives Release (atomar umgehängt)
 *   env/{web,realtime,watchdog}.env   aus .env.prod erzeugt, nur die Schlüssel je App (600)
 *   build/<sha>/                temporärer Build aus `git archive`
 *   state.json                  Aktivierungen (Rollback-Stapel) und Historie
 *   deploy.lock                 verhindert parallele Deploys
 */
import { join, resolve } from "node:path";

export const APP_KEYS = ["web", "realtime", "watchdog"] as const;
export type AppKey = (typeof APP_KEYS)[number];

export interface AppSpec {
  key: AppKey;
  /** pm2-Name (exakt wie in ecosystem.config.js). */
  name: string;
  /** Datei im Release, die vorhanden sein muss, damit die App startet. */
  entry: string;
  /** Arbeitsverzeichnis im Release (pm2 `cwd`, relativ zu releases/<sha>). */
  cwd: string;
}

export const APPS: Record<AppKey, AppSpec> = {
  web: { key: "web", name: "quizmaster-web", entry: "web/apps/web/server.js", cwd: "web/apps/web" },
  realtime: { key: "realtime", name: "quizmaster-realtime", entry: "realtime/dist/index.mjs", cwd: "realtime" },
  watchdog: { key: "watchdog", name: "quizmaster-watchdog", entry: "realtime/dist/watchdog.mjs", cwd: "realtime" },
};

export const APP_NAMES: readonly string[] = APP_KEYS.map((key) => APPS[key].name);

export interface Layout {
  root: string;
  ecosystem: string;
  deployDir: string;
  releasesDir: string;
  current: string;
  envDir: string;
  buildRoot: string;
  runtimeDir: string;
  stateFile: string;
  lockFile: string;
}

/**
 * Layout der Produktion (`.deploy`) bzw. – nur für Tests des Werkzeugs – `.deploy/test`: Test-Deploys dürfen
 * `current`, Env-Dateien und Releases der Produktion nie berühren. ecosystem.config.js folgt über
 * `QM_DEPLOY_DIR` (ausschließlich dieser eine Testpfad ist dort erlaubt).
 */
export function layoutFor(root: string, mode: "prod" | "test" = "prod"): Layout {
  const repoRoot = resolve(root);
  const deployDir = mode === "test" ? join(repoRoot, ".deploy", "test") : join(repoRoot, ".deploy");
  return {
    root: repoRoot,
    ecosystem: join(repoRoot, "ecosystem.config.js"),
    deployDir,
    releasesDir: join(deployDir, "releases"),
    current: join(deployDir, "current"),
    envDir: join(deployDir, "env"),
    buildRoot: join(deployDir, "build"),
    runtimeDir: join(deployDir, "runtime"),
    stateFile: join(deployDir, "state.json"),
    lockFile: join(deployDir, "deploy.lock"),
  };
}

export function releaseDir(layout: Layout, sha: string): string {
  return join(layout.releasesDir, sha);
}

export function envFile(layout: Layout, app: AppKey): string {
  return join(layout.envDir, `${app}.env`);
}

/** Vollständiger Git-Commit (40 Hex-Zeichen, klein). */
export const SHA_PATTERN = /^[0-9a-f]{40}$/;
