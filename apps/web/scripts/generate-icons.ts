// App-Icons erzeugen (docs/10): aus der SVG-Vorlage public/icons/icon.svg (orangefarbenes Quadrat-Signet mit
// dem Wortmarken-Initial auf Studio-Navy) alle Varianten nach public/icons/ – klein und committbar.
//
//   node apps/web/scripts/generate-icons.ts
//
// sharp (devDependency, ADR-031) rendert das SVG über libvips/librsvg – ohne Systemschriften, da das Initial
// aus Formen besteht. Varianten: 192/512 („any“, abgerundet, transparente Ecken), maskable 512 (vollflächig,
// Signet innerhalb der Sicherheitszone: Kreis mit 40 % Radius), Apple 180 (vollflächig, ohne Alphakanal) und
// Favicon (SVG + ICO 16/32/48, Signet größer, damit das „q“ bei 16 px lesbar bleibt).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";

const webRoot = path.resolve(import.meta.dirname, "..");
export const ICONS_DIR = path.join(webRoot, "public", "icons");
export const TEMPLATE_FILE = path.join(ICONS_DIR, "icon.svg");

/** Vorlage im 512er-Raster: Titel, Hintergrund (Farbe, Eckenradius) und die Formen des Signets. */
export interface IconTemplate {
  /** Textalternative (`<title>`), auch in den erzeugten SVGs */
  title: string;
  background: string;
  radius: number;
  signet: string;
}

const VIEWBOX = 512;

export function parseTemplate(svg: string): IconTemplate {
  const backgroundTag = /<rect id="background"[^>]*\/>/.exec(svg)?.[0];
  const background = backgroundTag ? /fill="(#[0-9A-Fa-f]{6})"/.exec(backgroundTag)?.[1] : undefined;
  const radius = backgroundTag ? Number(/rx="(\d+)"/.exec(backgroundTag)?.[1] ?? Number.NaN) : Number.NaN;
  const signet = /<g id="signet">([\s\S]*?)<\/g>/.exec(svg)?.[1]?.trim();
  const title = /<title>([^<]+)<\/title>/.exec(svg)?.[1]?.trim();
  if (!title || !background || !Number.isFinite(radius) || !signet) {
    throw new Error('icon.svg: <title>, <rect id="background" rx fill> und <g id="signet"> werden gebraucht');
  }
  if (!svg.includes(`viewBox="0 0 ${VIEWBOX} ${VIEWBOX}"`))
    throw new Error(`icon.svg: viewBox 0 0 ${VIEWBOX} ${VIEWBOX} erwartet`);
  return { title, background, radius, signet };
}

export interface IconLayout {
  /** abgerundet mit transparenten Ecken oder vollflächig (maskable, Apple) */
  shape: "rounded" | "square";
  /** Skalierung des Signets um die Mitte */
  signetScale: number;
}

/** Setzt eine Variante als SVG zusammen. */
export function composeIcon(template: IconTemplate, layout: IconLayout): string {
  const radius = layout.shape === "rounded" ? ` rx="${template.radius}"` : "";
  const center = VIEWBOX / 2;
  const transform =
    layout.signetScale === 1
      ? ""
      : ` transform="translate(${center} ${center}) scale(${layout.signetScale}) translate(-${center} -${center})"`;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEWBOX} ${VIEWBOX}">`,
    `<title>${template.title}</title>`,
    `<rect width="${VIEWBOX}" height="${VIEWBOX}"${radius} fill="${template.background}"/>`,
    `<g${transform}>${template.signet}</g>`,
    "</svg>\n",
  ].join("");
}

export interface PngVariant extends IconLayout {
  file: string;
  size: number;
  /** ohne Alphakanal (Apple-Icon: iOS füllt Transparenz schwarz) */
  opaque: boolean;
}

/** Größe des Signets im Favicon: das „q“ muss bei 16 px erkennbar bleiben. */
export const FAVICON_SIGNET_SCALE = 1.4;

export const PNG_VARIANTS: readonly PngVariant[] = [
  { file: "icon-192.png", size: 192, shape: "rounded", signetScale: 1, opaque: false },
  { file: "icon-512.png", size: 512, shape: "rounded", signetScale: 1, opaque: false },
  { file: "icon-maskable-512.png", size: 512, shape: "square", signetScale: 1, opaque: true },
  { file: "apple-icon-180.png", size: 180, shape: "square", signetScale: 1, opaque: true },
];

export const FAVICON_SIZES = [16, 32, 48] as const;

async function renderPng(
  svg: string,
  size: number,
  options: { opaque: boolean; background: string; palette: boolean },
) {
  // Hohe Dichte, dann verkleinern: saubere Kanten auch bei 16 px.
  let image = sharp(Buffer.from(svg), { density: Math.max(72, Math.ceil((72 * size * 4) / VIEWBOX)) }).resize(
    size,
    size,
  );
  if (options.opaque) image = image.flatten({ background: options.background }).removeAlpha();
  return image.png({ compressionLevel: 9, adaptiveFiltering: true, palette: options.palette, effort: 10 }).toBuffer();
}

/** ICO-Container mit PNG-Einträgen (von allen aktuellen Browsern unterstützt). */
export function encodeIco(images: readonly { size: number; png: Buffer }[]): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;
  images.forEach(({ size, png }, index) => {
    const entry = index * 16;
    directory.writeUInt8(size >= 256 ? 0 : size, entry);
    directory.writeUInt8(size >= 256 ? 0 : size, entry + 1);
    directory.writeUInt8(0, entry + 2);
    directory.writeUInt8(0, entry + 3);
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(png.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([header, directory, ...images.map((image) => image.png)]);
}

export interface GeneratedIcon {
  file: string;
  bytes: number;
}

export async function generateIcons(outDir: string = ICONS_DIR): Promise<GeneratedIcon[]> {
  const template = parseTemplate(readFileSync(TEMPLATE_FILE, "utf8"));
  mkdirSync(outDir, { recursive: true });
  const written: GeneratedIcon[] = [];
  const write = (file: string, contents: Buffer | string) => {
    writeFileSync(path.join(outDir, file), contents);
    written.push({ file, bytes: Buffer.byteLength(contents) });
  };

  for (const variant of PNG_VARIANTS) {
    const png = await renderPng(composeIcon(template, variant), variant.size, {
      opaque: variant.opaque,
      background: template.background,
      palette: true,
    });
    write(variant.file, png);
  }

  const favicon = composeIcon(template, { shape: "rounded", signetScale: FAVICON_SIGNET_SCALE });
  write("favicon.svg", favicon);
  const icoImages = [];
  for (const size of FAVICON_SIZES) {
    icoImages.push({
      size,
      png: await renderPng(favicon, size, { opaque: false, background: template.background, palette: false }),
    });
  }
  write("favicon.ico", encodeIco(icoImages));
  return written;
}

if (import.meta.main) {
  const written = await generateIcons();
  for (const icon of written) {
    console.info(`generate-icons – public/icons/${icon.file} (${(icon.bytes / 1024).toFixed(1)} KB)`);
  }
}
