/**
 * Node-Laufzeit für pm2 (`.deploy/runtime/node`, ADR-024/026): eine verifizierte Kopie der Node-24-Toolchain
 * aus `.tooling`. Verifiziert heißt: das Tarball in `.tooling/downloads` stimmt mit `SHASUMS256.txt` überein,
 * wird frisch entpackt, und `bin/node` ist bitgleich mit `.tooling/node/bin/node`. So läuft Produktion nie
 * auf einer (versehentlich) veränderten Toolchain, und ein Toolchain-Update wirkt erst beim nächsten Deploy.
 */
import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import type { Layout } from "./layout.ts";
import { DeployError, info, ok } from "./log.ts";
import { runChecked, SYSTEM_PATH } from "./proc.ts";

const DIST_PATTERN = /^node-(v(\d+)\.\d+\.\d+)-linux-(x64|arm64)$/;

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Erwarteter Hash einer Datei laut SHASUMS256.txt (Format „<hex>  <name>“). */
export function expectedChecksum(shasums: string, fileName: string): string | null {
  for (const line of shasums.split("\n")) {
    const match = /^([0-9a-f]{64})\s+\*?(\S+)$/.exec(line.trim());
    if (match && match[2] === fileName) return match[1] ?? null;
  }
  return null;
}

export interface RuntimeInfo {
  version: string;
  /** Interpreter-Pfad über den Symlink (so steht er in ecosystem.config.js). */
  node: string;
  created: boolean;
}

async function verifiedHashOf(dir: string): Promise<string | null> {
  const marker = join(dir, ".verified.json");
  const binary = join(dir, "bin", "node");
  if (!existsSync(marker) || !existsSync(binary)) return null;
  let recorded: unknown;
  try {
    recorded = (JSON.parse(readFileSync(marker, "utf8")) as { nodeSha256?: unknown }).nodeSha256;
  } catch {
    return null;
  }
  if (typeof recorded !== "string") return null;
  return (await sha256File(binary)) === recorded ? recorded : null;
}

/** Stellt `.deploy/runtime/node` bereit (idempotent) und liefert den Interpreter-Pfad. */
export async function ensureRuntime(layout: Layout): Promise<RuntimeInfo> {
  const toolingNode = join(layout.root, ".tooling", "node");
  if (!existsSync(toolingNode)) {
    throw new DeployError("TOOLCHAIN_MISSING", ".tooling/node fehlt (ADR-026: source .tooling/activate.sh)");
  }
  const distName = basename(realpathSync(toolingNode));
  const match = DIST_PATTERN.exec(distName);
  if (match?.[2] !== "24") {
    throw new DeployError("TOOLCHAIN_VERSION", `.tooling/node ist ${distName}, erwartet Node 24 (linux)`);
  }
  const version = match[1] ?? "";
  mkdirSync(layout.runtimeDir, { recursive: true, mode: 0o755 });
  const target = join(layout.runtimeDir, distName);
  const toolingHash = await sha256File(join(toolingNode, "bin", "node"));
  const existing = await verifiedHashOf(target);
  let created = false;

  if (existing === null) {
    const downloads = join(layout.root, ".tooling", "downloads");
    const tarball = join(downloads, `${distName}.tar.xz`);
    const sums = join(downloads, "SHASUMS256.txt");
    if (!existsSync(tarball) || !existsSync(sums)) {
      throw new DeployError(
        "RUNTIME_UNVERIFIABLE",
        `${distName}.tar.xz oder SHASUMS256.txt fehlt in .tooling/downloads – Laufzeit nicht verifizierbar`,
      );
    }
    const expected = expectedChecksum(readFileSync(sums, "utf8"), `${distName}.tar.xz`);
    const actual = await sha256File(tarball);
    if (expected === null || expected !== actual) {
      throw new DeployError("RUNTIME_CHECKSUM", `${distName}.tar.xz passt nicht zu SHASUMS256.txt`);
    }
    const staging = join(layout.runtimeDir, `.${distName}.partial`);
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true, mode: 0o755 });
    try {
      await runChecked("tar (Node-Laufzeit)", "tar", ["-xJf", tarball, "-C", staging, "--no-same-owner"], {
        env: { PATH: SYSTEM_PATH, LANG: "C" },
        output: "capture",
        timeoutMs: 180_000,
      });
      const extracted = join(staging, distName);
      const nodeHash = await sha256File(join(extracted, "bin", "node"));
      if (nodeHash !== toolingHash) {
        throw new DeployError(
          "RUNTIME_MISMATCH",
          ".tooling/node/bin/node weicht vom verifizierten Tarball ab – Toolchain prüfen (ADR-026)",
        );
      }
      const probe = await runChecked("node -v (Laufzeit)", join(extracted, "bin", "node"), ["-v"], {
        env: { PATH: SYSTEM_PATH },
        output: "capture",
        timeoutMs: 15_000,
      });
      if (probe.stdout.trim() !== version) {
        throw new DeployError("RUNTIME_VERSION", `Laufzeit meldet ${probe.stdout.trim()}, erwartet ${version}`);
      }
      const meta = { version, tarball: `${distName}.tar.xz`, tarballSha256: actual, nodeSha256: nodeHash };
      writeFileSync(join(extracted, ".verified.json"), `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o644 });
      rmSync(target, { recursive: true, force: true });
      renameSync(extracted, target);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
    created = true;
    ok(`Node-Laufzeit ${version} verifiziert (SHASUMS256, bitgleich mit .tooling) → .deploy/runtime`);
  } else if (existing !== toolingHash) {
    info(`Hinweis: .tooling/node weicht von der verifizierten Laufzeit ${version} ab – Laufzeit bleibt unverändert`);
  }

  // Symlink atomar umhängen; andere Versionen entfernen (laufende Prozesse behalten ihr Binary im Speicher).
  const link = join(layout.runtimeDir, "node");
  const tmpLink = join(layout.runtimeDir, `.node.${process.pid}.tmp`);
  rmSync(tmpLink, { force: true });
  symlinkSync(distName, tmpLink);
  renameSync(tmpLink, link);
  for (const name of readdirSync(layout.runtimeDir)) {
    if (name !== distName && DIST_PATTERN.test(name)) rmSync(join(layout.runtimeDir, name), { recursive: true });
  }
  return { version, node: join(link, "bin", "node"), created };
}
