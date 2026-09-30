/**
 * `content:validate` als Funktion: lädt einen Content-Ordner, prüft Schema + Regeln und filtert
 * optional auf einzelne Dateien (die ID-Eindeutigkeit wird trotzdem über ALLE Dateien geprüft).
 */
import { resolve } from "node:path";
import { countBySeverity, type Finding } from "./findings.ts";
import { loadFlagCodes } from "./flags.ts";
import { type LoadedCatalog, loadCatalog } from "./load.ts";
import { displayPath } from "./paths.ts";
import { checkCatalogRules } from "./rules.ts";

export interface ValidationResult {
  catalog: LoadedCatalog;
  findings: Finding[];
  errors: number;
  warnings: number;
}

export interface ValidateOptions {
  /** Nur Befunde dieser Dateien melden (absolute Pfade). */
  onlyFiles?: readonly string[];
  flagCodes?: ReadonlySet<string>;
}

export function validateContentDir(contentDir: string, options: ValidateOptions = {}): ValidationResult {
  const catalog = loadCatalog(contentDir);
  const all = [...catalog.findings, ...checkCatalogRules(catalog, { flagCodes: options.flagCodes ?? loadFlagCodes() })];
  const only =
    options.onlyFiles === undefined ? undefined : new Set(options.onlyFiles.map((file) => displayPath(resolve(file))));
  const findings = only === undefined ? all : all.filter((finding) => only.has(finding.file));
  return { catalog, findings, ...countBySeverity(findings) };
}
