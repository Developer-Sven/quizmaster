/**
 * Build eines Releases (ADR-025): `git archive <sha>` → `.deploy/build/<sha>` → `pnpm install
 * --frozen-lockfile --offline` (Store in .tooling) → Audit-Gate → Web (Next standalone + .next/static +
 * public) und Realtime (tsdown + `pnpm deploy --prod` für produktive node_modules) → `.deploy/releases/<sha>`.
 *
 * Das Release ist in sich geschlossen: keine absoluten Symlinks, keine Verweise aus dem Release heraus –
 * das Build-Verzeichnis wird danach gelöscht. Besitz und Rechte sind einheitlich (Deploy-Benutzer, Verzeichnisse
 * und ausführbare Dateien 755, sonst 644): lesbar für den Dienstbenutzer, für ihn nicht veränderbar (lib/access.ts).
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lchownSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { deployIdentity, removeTree, type TreeRemover } from "./access.ts";
import { extractArchive } from "./git.ts";
import { APPS, type Layout, releaseDir } from "./layout.ts";
import { DeployError, info, ok, step } from "./log.ts";
import { run, runChecked } from "./proc.ts";

export interface ReleaseMeta {
  sha: string;
  builtAt: string;
  subject: string;
  hasWatchdog: boolean;
  webBuildId: string | null;
}

export interface BuildContext {
  layout: Layout;
  repo: string;
  sha: string;
  subject: string;
  pnpm: string;
  env: Record<string, string>;
}

const INSTALL_TIMEOUT = 15 * 60_000;
const BUILD_TIMEOUT = 30 * 60_000;

export function buildDirOf(layout: Layout, sha: string): string {
  return join(layout.buildRoot, sha);
}

/** Metadaten eines vollständigen Releases oder `null` (fehlt, unvollständig, fremdes SHA). */
export function readReleaseMeta(layout: Layout, sha: string): ReleaseMeta | null {
  const dir = releaseDir(layout, sha);
  const file = join(dir, "release.json");
  if (!existsSync(file)) return null;
  let meta: ReleaseMeta;
  try {
    meta = JSON.parse(readFileSync(file, "utf8")) as ReleaseMeta;
  } catch {
    return null;
  }
  if (meta.sha !== sha) return null;
  if (!existsSync(join(dir, APPS.web.entry)) || !existsSync(join(dir, APPS.realtime.entry))) return null;
  return { ...meta, hasWatchdog: existsSync(join(dir, APPS.watchdog.entry)) };
}

/** Alle Release-Verzeichnisse (nur volle SHAs, keine Arbeitsverzeichnisse). */
export function listReleases(layout: Layout): string[] {
  if (!existsSync(layout.releasesDir)) return [];
  return readdirSync(layout.releasesDir).filter((name) => /^[0-9a-f]{40}$/.test(name));
}

/** Quelltext holen (immer frisch). */
export async function prepareSource(ctx: BuildContext): Promise<string> {
  const dir = buildDirOf(ctx.layout, ctx.sha);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(ctx.layout.buildRoot, { recursive: true, mode: 0o700 });
  await extractArchive(ctx.repo, ctx.sha, dir);
  if (!existsSync(join(dir, "pnpm-lock.yaml"))) {
    throw new DeployError("SOURCE_INVALID", "git archive enthält kein pnpm-lock.yaml");
  }
  ok(`Quelltext ${ctx.sha.slice(0, 12)} aus git archive entpackt`);
  return dir;
}

/** `pnpm audit --prod --audit-level high` – hohe/kritische Befunde in Produktionsabhängigkeiten brechen ab. */
export async function auditGate(ctx: BuildContext, dir: string): Promise<void> {
  const result = await run(ctx.pnpm, ["audit", "--prod", "--audit-level", "high"], {
    cwd: dir,
    env: ctx.env,
    output: "inherit",
    timeoutMs: 180_000,
  });
  if (result.timedOut) throw new DeployError("AUDIT_TIMEOUT", "pnpm audit: Zeitlimit überschritten");
  if (result.code !== 0) {
    throw new DeployError(
      "AUDIT_FAILED",
      "pnpm audit meldet hohe/kritische Befunde (oder die Registry ist nicht erreichbar). " +
        "Beheben und neu deployen; nur im Notfall bewusst mit --skip-audit",
    );
  }
  ok("Audit-Gate bestanden (keine hohen/kritischen Befunde in Produktionsabhängigkeiten)");
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Prüft, dass alle Symlinks im Release relativ sind, innerhalb des Releases bleiben und auflösbar sind.
 */
export function verifySelfContained(root: string): { files: number; links: number } {
  const base = resolve(root);
  let files = 0;
  // Eigener Durchlauf: Symlinks werden geprüft, aber nie verfolgt (readdir recursive folgt Verzeichnis-Links).
  const pending = [base];
  const links: string[] = [];
  while (pending.length > 0) {
    const dir = pending.pop() ?? base;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) links.push(full);
      else if (entry.isDirectory()) pending.push(full);
      else if (entry.isFile()) files += 1;
    }
  }
  for (const full of links) {
    const target = readlinkSync(full);
    if (isAbsolute(target)) {
      throw new DeployError("RELEASE_ABSOLUTE_LINK", `absoluter Symlink im Release: ${relative(base, full)}`);
    }
    const resolved = resolve(dirname(full), target);
    const rel = relative(base, resolved);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new DeployError("RELEASE_ESCAPING_LINK", `Symlink zeigt aus dem Release heraus: ${relative(base, full)}`);
    }
    if (!existsSync(resolved)) {
      throw new DeployError("RELEASE_BROKEN_LINK", `defekter Symlink im Release: ${relative(base, full)}`);
    }
  }
  return { files, links: links.length };
}

/**
 * Vereinheitlicht Besitz und Rechte eines frisch gebauten Releases (ohne Symlinks zu folgen): Besitzer und Gruppe
 * des Deploys, Verzeichnisse und ausführbare Dateien 0755, alle anderen Dateien 0644 – keine Schreibrechte für
 * Gruppe/andere, keine setuid/setgid/sticky-Bits. Ändert nur, was abweicht; liefert die Anzahl der Änderungen.
 */
export function normalizeReleaseModes(root: string): number {
  const owner = deployIdentity();
  let changed = 0;
  const pending = [resolve(root)];
  while (pending.length > 0) {
    const path = pending.pop() ?? root;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) continue;
    if (!stat.isDirectory() && !stat.isFile()) {
      throw new DeployError("RELEASE_FILE_TYPE", `unerwarteter Dateityp im Release: ${relative(root, path)}`);
    }
    let touched = false;
    if (stat.uid !== owner.uid || stat.gid !== owner.gid) {
      lchownSync(path, owner.uid, owner.gid);
      touched = true;
    }
    const wanted = stat.isDirectory() || (stat.mode & 0o100) !== 0 ? 0o755 : 0o644;
    if ((stat.mode & 0o7777) !== wanted) {
      chmodSync(path, wanted);
      touched = true;
    }
    if (touched) changed += 1;
    if (stat.isDirectory()) for (const name of readdirSync(path)) pending.push(join(path, name));
  }
  return changed;
}

/** Installiert, baut und setzt das Release zusammen. Liefert die Metadaten des fertigen Releases. */
export async function buildRelease(ctx: BuildContext, dir: string): Promise<ReleaseMeta> {
  const { layout, sha } = ctx;
  step("Build: Abhängigkeiten (pnpm install --frozen-lockfile --offline)");
  const install = await run(ctx.pnpm, ["install", "--frozen-lockfile", "--offline"], {
    cwd: dir,
    env: ctx.env,
    output: "inherit",
    timeoutMs: INSTALL_TIMEOUT,
  });
  if (install.code !== 0 || install.timedOut) {
    throw new DeployError(
      "INSTALL_FAILED",
      "pnpm install --offline fehlgeschlagen – fehlen Pakete im Store? Erst im Repo `pnpm install` ausführen",
    );
  }

  step("Build: Web (Next.js standalone)");
  await runChecked("pnpm --filter @quizmaster/web build", ctx.pnpm, ["--filter", "@quizmaster/web", "build"], {
    cwd: dir,
    env: ctx.env,
    output: "inherit",
    timeoutMs: BUILD_TIMEOUT,
  });
  step("Build: Realtime (tsdown)");
  await runChecked(
    "pnpm --filter @quizmaster/realtime build",
    ctx.pnpm,
    ["--filter", "@quizmaster/realtime", "build"],
    { cwd: dir, env: ctx.env, output: "inherit", timeoutMs: BUILD_TIMEOUT },
  );

  step("Release zusammensetzen");
  mkdirSync(layout.releasesDir, { recursive: true, mode: 0o755 });
  const partial = join(layout.releasesDir, `.${sha}.partial`);
  rmSync(partial, { recursive: true, force: true });
  mkdirSync(partial, { recursive: true, mode: 0o755 });
  try {
    // Web: standalone-Ausgabe + statische Assets + public (docs/12, Next-Doku „output: standalone“).
    const webApp = join(dir, "apps", "web");
    const standalone = join(webApp, ".next", "standalone");
    if (!existsSync(join(standalone, "apps", "web", "server.js"))) {
      throw new DeployError(
        "WEB_STANDALONE_MISSING",
        "apps/web/.next/standalone/apps/web/server.js fehlt (next.config: output standalone + outputFileTracingRoot)",
      );
    }
    renameSync(standalone, join(partial, "web"));
    cpSync(join(webApp, ".next", "static"), join(partial, "web", "apps", "web", ".next", "static"), {
      recursive: true,
      verbatimSymlinks: true,
    });
    if (existsSync(join(webApp, "public"))) {
      cpSync(join(webApp, "public"), join(partial, "web", "apps", "web", "public"), {
        recursive: true,
        verbatimSymlinks: true,
      });
    }
    const buildIdFile = join(partial, "web", "apps", "web", ".next", "BUILD_ID");
    const webBuildId = existsSync(buildIdFile) ? readFileSync(buildIdFile, "utf8").trim() : null;

    // Realtime: produktive node_modules über `pnpm deploy --prod` (Workspace-Pakete sind eingebündelt).
    const realtimeTarget = join(partial, "realtime");
    await runChecked(
      "pnpm --filter @quizmaster/realtime deploy --prod",
      ctx.pnpm,
      ["--filter", "@quizmaster/realtime", "deploy", "--prod", "--offline", realtimeTarget],
      { cwd: dir, env: ctx.env, output: "inherit", timeoutMs: INSTALL_TIMEOUT },
    );
    const builtDist = join(dir, "apps", "realtime", "dist");
    for (const file of readdirSync(builtDist)) {
      const deployed = join(realtimeTarget, "dist", file);
      if (!existsSync(deployed) || sha256(deployed) !== sha256(join(builtDist, file))) {
        throw new DeployError("REALTIME_DIST_MISMATCH", `realtime/dist/${file} fehlt im Deploy-Verzeichnis`);
      }
    }
    // Quelltext und Werkzeug-Konfiguration braucht die Laufzeit nicht.
    for (const extra of ["src", "test", "tsconfig.json", "tsdown.config.ts", "vitest.config.ts"]) {
      rmSync(join(realtimeTarget, extra), { recursive: true, force: true });
    }

    const counts = verifySelfContained(partial);
    const normalized = normalizeReleaseModes(partial);
    if (normalized > 0) info(`Rechte vereinheitlicht: ${normalized} Einträge (755/644, Besitzer Deploy-Benutzer)`);
    const hasWatchdog = existsSync(join(partial, APPS.watchdog.entry));
    const meta: ReleaseMeta = {
      sha,
      builtAt: new Date().toISOString(),
      subject: ctx.subject,
      hasWatchdog,
      webBuildId,
    };
    writeFileSync(join(partial, "release.json"), `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o644 });

    const final = releaseDir(layout, sha);
    if (existsSync(final)) {
      const aside = join(layout.releasesDir, `.${sha}.replaced-${Date.now()}`);
      renameSync(final, aside);
      renameSync(partial, final);
      // Das ersetzte Release kann einen vom Dienstbenutzer beschriebenen .next/cache enthalten.
      await removeTree(aside);
    } else {
      renameSync(partial, final);
    }
    ok(`Release ${sha.slice(0, 12)} fertig (${counts.files} Dateien, ${counts.links} relative Symlinks geprüft)`);
    info(hasWatchdog ? "Watchdog im Release enthalten (dist/watchdog.mjs)" : "Watchdog nicht im Release");
    return meta;
  } catch (error) {
    rmSync(partial, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Build-Verzeichnis und liegengebliebene Arbeitsverzeichnisse entfernen. Ersetzte Releases (`.replaced-`) können
 * vom Dienstbenutzer beschriebene Verzeichnisse enthalten – sie löscht nur `remove` (GNU rm, lib/access.ts).
 */
export async function cleanupBuild(layout: Layout, remove: TreeRemover = removeTree): Promise<void> {
  rmSync(layout.buildRoot, { recursive: true, force: true });
  if (!existsSync(layout.releasesDir)) return;
  for (const name of readdirSync(layout.releasesDir)) {
    if (name.startsWith(".") && (name.includes(".partial") || name.includes(".replaced-"))) {
      await remove(join(layout.releasesDir, name));
    }
  }
}
