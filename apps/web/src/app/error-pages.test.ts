import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ErrorView, ToStartLink } from "../components/app/error-view";
import { renderHtml } from "../components/ui/ssr-render";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

/**
 * Die Fehler-Chunks (app/error.tsx, app/global-error.tsx samt ErrorView) laden mit dem Layout auf jeder Seite
 * (docs/07 Initial-JS). Sie bleiben schlank: schlichte `<button>`/`<a>` mit den Button-Klassen statt
 * `Button`/`ButtonLink` – deren Modul zieht `next/link` und weitere Icons in jeden Chunk (Befund W3: −13 KB
 * gzip auf `/`).
 */
describe("Fehlerseiten bleiben schlank (Initial-JS jeder Seite)", () => {
  it("importieren weder das Button-Modul noch next/link", () => {
    for (const path of ["./error.tsx", "./global-error.tsx", "../components/app/error-view.tsx"]) {
      const source = read(path);
      expect(source, path).not.toMatch(
        /from\s+["'](?:@\/components\/ui|\.\.?\/ui|\.\.\/\.\.\/components\/ui)\/button["']/,
      );
      expect(source, path).not.toMatch(/from\s+["']next\/link["']/);
    }
  });

  it("teilen die Schrift mit dem Layout (eine next/font-Instanz, keine zweite @font-face-CSS)", () => {
    expect(read("./global-error.tsx")).toMatch(/import \{ rubik \} from "\.\/fonts"/);
    expect(read("./layout.tsx")).toMatch(/import \{ rubik \} from "\.\/fonts"/);
    for (const path of ["./global-error.tsx", "./layout.tsx"]) {
      expect(read(path), path).not.toContain("next/font/google");
    }
  });

  it("zeigen „Zur Startseite“ als Link im Button-Look (volle Navigation)", () => {
    expect(renderHtml(ToStartLink, { variant: "ghost" })).toMatch(
      /^<a href="\/" class="[^"]*min-h-14[^"]*w-full"><span class="min-w-0 text-center wrap-break-word">Zur Startseite<\/span><\/a>$/,
    );
    const page = renderHtml(ErrorView, { message: "Seite nicht gefunden." });
    expect(page).toContain('<a href="/" class="');
    expect(page).toContain("border border-transparent bg-primary");
  });
});
