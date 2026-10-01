import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";
import manifest from "./manifest";

const PUBLIC_DIR = fileURLToPath(new URL("../../public/", import.meta.url));

interface PngInfo {
  width: number;
  height: number;
  /** Farbtyp aus dem IHDR (2 = RGB, 3 = Palette, 6 = RGBA) */
  colorType: number;
  chunks: string[];
}

/** Liest Größe, Farbtyp und Chunk-Liste einer PNG-Datei (ohne Zusatzpaket). */
function readPng(publicPath: string): PngInfo {
  const bytes = readFileSync(`${PUBLIC_DIR}${publicPath.replace(/^\//, "")}`);
  expect(bytes.subarray(0, 8).toString("hex"), publicPath).toBe("89504e470d0a1a0a");
  const chunks: string[] = [];
  let offset = 8;
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    chunks.push(bytes.toString("ascii", offset + 4, offset + 8));
    offset += 12 + length;
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), colorType: bytes[25] ?? -1, chunks };
}

/** Keine Transparenz: weder Alphakanal (Farbtyp 4/6) noch tRNS-Chunk. */
function isOpaque(png: PngInfo): boolean {
  return png.colorType !== 4 && png.colorType !== 6 && !png.chunks.includes("tRNS");
}

describe("Web-App-Manifest (docs/10)", () => {
  it("entspricht exakt der Vorgabe aus docs/10", () => {
    expect(manifest()).toEqual({
      id: "/",
      name: "quizmaster – Das Live-Quiz",
      short_name: "quizmaster",
      description: "Quiz-Duelle live mit Freund:innen – ohne Anmeldung.",
      lang: "de",
      start_url: "/?source=pwa",
      scope: "/",
      display: "standalone",
      orientation: "portrait",
      background_color: "#0B1426",
      theme_color: "#0B1426",
      categories: ["games", "education", "entertainment"],
      icons: [
        { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
        { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
        { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      ],
      screenshots: [
        {
          src: "/screenshots/lobby.png",
          sizes: "1080x1920",
          type: "image/png",
          form_factor: "narrow",
          label: "Lobby mit Code",
        },
        {
          src: "/screenshots/frage.png",
          sizes: "1080x1920",
          type: "image/png",
          form_factor: "narrow",
          label: "Frage mit Timer",
        },
      ],
      shortcuts: [
        { name: "Lobby erstellen", url: "/?action=create" },
        { name: "Lobby beitreten", url: "/?action=join" },
      ],
    });
  });

  it("wird immer revalidiert (next.config.ts), damit Änderungen nach einem Deploy sofort gelten", async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    expect(rules.find((rule) => rule.source === "/manifest.webmanifest")?.headers).toEqual([
      { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
    ]);
  });

  it("erfüllt die Installierbarkeit: Icon ≥ 192 und 512, maskable, Start-URL im Scope", () => {
    const { icons = [], start_url: startUrl = "", scope = "" } = manifest();
    expect(icons.map((icon) => icon.sizes)).toEqual(expect.arrayContaining(["192x192", "512x512"]));
    expect(icons.some((icon) => icon.purpose === "maskable")).toBe(true);
    expect(startUrl.startsWith(scope)).toBe(true);
  });

  it("verweist nur auf vorhandene PNGs in genau der angegebenen Größe", () => {
    const { icons = [], screenshots = [] } = manifest();
    for (const image of [...icons, ...screenshots]) {
      const png = readPng(image.src);
      expect(`${png.width}x${png.height}`, image.src).toBe(image.sizes);
    }
  });

  it("maskable- und Apple-Icon haben keine Transparenz, die normalen Icons runde, freie Ecken", () => {
    expect(isOpaque(readPng("/icons/icon-maskable-512.png"))).toBe(true);
    const apple = readPng("/icons/apple-icon-180.png");
    expect([apple.width, apple.height]).toEqual([180, 180]);
    expect(isOpaque(apple)).toBe(true);
    expect(isOpaque(readPng("/icons/icon-512.png"))).toBe(false);
  });

  it("hält beim maskable-Icon das Signet in der Sicherheitszone (Kreis mit 40 % Radius)", async () => {
    const { data, info } = await sharp(`${PUBLIC_DIR}icons/icon-maskable-512.png`)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const center = info.width / 2;
    const safeRadius = info.width * 0.4;
    let outside = 0;
    let foreign = 0;
    for (let y = 0; y < info.height; y += 1) {
      for (let x = 0; x < info.width; x += 1) {
        if (Math.hypot(x + 0.5 - center, y + 0.5 - center) <= safeRadius) continue;
        outside += 1;
        const offset = (y * info.width + x) * 4;
        const [r, g, b, a] = [data[offset], data[offset + 1], data[offset + 2], data[offset + 3]];
        // Außerhalb der Zone nur Studio-Navy #0B1426, voll deckend
        if (r !== 0x0b || g !== 0x14 || b !== 0x26 || a !== 255) foreign += 1;
      }
    }
    expect(outside).toBeGreaterThan(0);
    expect(foreign).toBe(0);
  });

  it("liefert Favicons als SVG und ICO (16, 32, 48)", () => {
    const svg = readFileSync(`${PUBLIC_DIR}icons/favicon.svg`, "utf8");
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 512 512">/);
    expect(svg).not.toMatch(/<script|href=|<image/i);
    const ico = readFileSync(`${PUBLIC_DIR}icons/favicon.ico`);
    expect(ico.readUInt16LE(2)).toBe(1);
    const count = ico.readUInt16LE(4);
    const sizes = Array.from({ length: count }, (_, index) => ico.readUInt8(6 + index * 16));
    expect(sizes).toEqual([16, 32, 48]);
  });
});
