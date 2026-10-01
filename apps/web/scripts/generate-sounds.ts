// Erzeugt die sieben Spiel-Sounds (docs/09 §10): lock, tick, correct, wrong, turn, win, lose.
//
//   node apps/web/scripts/generate-sounds.ts          synthetisieren + kodieren → apps/web/public/sounds/
//   node apps/web/scripts/generate-sounds.ts --check  nur prüfen (Dateien vorhanden, ≤ 20 KB, Lizenz)
//
// Die Klänge sind eigene Synthesen (Sinus-Teiltöne mit weicher Hüllkurve, keine Samples) und stehen unter CC0
// (public/sounds/LICENSE.md). Jede Datei ist ≤ 400 ms lang, ihr Spitzenpegel liegt bei −12 dBFS
// (= „−12 dB gegenüber Vollpegel“), und sie ist als .webm (Opus) und .mp3 höchstens 20 KB groß.
// Die WAV-Rohdaten entstehen hier in Node (deterministisch, ohne Zufall); kodiert wird in EINEM einmaligen
// Container mit per Digest gepinntem ffmpeg-Image (`docker run --rm`, ohne Netzwerk, ohne Capabilities).
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** Statisches ffmpeg (mwader/static-ffmpeg 9.0.2, libopus + libmp3lame), Multi-Arch-Index per Digest gepinnt. */
export const FFMPEG_IMAGE =
  "docker.io/mwader/static-ffmpeg:9.0.2@sha256:7d9bdaaf887f7e6ce6151f67325c344074b5ff1fb75316011c3376503e449a7b";

export const SOUND_NAMES = ["lock", "tick", "correct", "wrong", "turn", "win", "lose"] as const;
export type SoundName = (typeof SOUND_NAMES)[number];

export const SAMPLE_RATE = 48_000;
/** Höchstdauer je Sound (docs/09 §10). */
export const MAX_DURATION_MS = 400;
/** Höchstgröße je Datei (docs/09 §10). */
export const MAX_FILE_BYTES = 20 * 1024;
/** Spitzenpegel: −12 dB gegenüber Vollpegel (docs/09 §10). */
export const PEAK_DBFS = -12;

const webRoot = path.resolve(import.meta.dirname, "..");
const outDir = path.join(webRoot, "public", "sounds");

// ---------------------------------------------------------------------------------------------------
// Synthese
// ---------------------------------------------------------------------------------------------------

interface Overtone {
  /** Frequenzverhältnis zum Grundton */
  ratio: number;
  /** Lautstärke relativ zum Grundton */
  gain: number;
}

interface Note {
  /** Grundfrequenz in Hz */
  hz: number;
  /** Startfrequenz eines kurzen Gleitens zum Grundton (optional) */
  fromHz?: number;
  /** Dauer des Gleitens in ms */
  glideMs?: number;
  /** Einsatz in ms */
  at: number;
  /** Länge in ms (danach ist der Ton still) */
  length: number;
  /** Anstieg in ms (weich, gegen Knackser) */
  attackMs: number;
  /** Abklingzeit (Zeitkonstante der e-Funktion) in ms */
  decayMs: number;
  /** relative Lautstärke der Note im Mix */
  level: number;
  partials: readonly Overtone[];
}

interface SoundDesign {
  /** Gesamtlänge in ms (≤ 400) */
  length: number;
  notes: readonly Note[];
}

const SOFT: readonly Overtone[] = [
  { ratio: 1, gain: 1 },
  { ratio: 2, gain: 0.18 },
  { ratio: 3, gain: 0.05 },
];

const HOLLOW: readonly Overtone[] = [
  { ratio: 1, gain: 1 },
  { ratio: 3, gain: 0.12 },
  { ratio: 5, gain: 0.03 },
];

const BELL: readonly Overtone[] = [
  { ratio: 1, gain: 1 },
  { ratio: 2, gain: 0.22 },
  { ratio: 2.76, gain: 0.06 },
];

/** Die sieben Klänge: kurz, weich, ohne harte Obertöne. Frequenzen in Hz (gleichstufig, A4 = 440). */
export const SOUND_DESIGNS: Readonly<Record<SoundName, SoundDesign>> = {
  // Einloggen: kurzer, weicher Tipp mit leichtem Abwärtsgleiten (C5 → A4)
  lock: {
    length: 140,
    notes: [
      { hz: 440, fromHz: 523.25, glideMs: 45, at: 0, length: 140, attackMs: 3, decayMs: 34, level: 1, partials: SOFT },
    ],
  },
  // Letzte 5 Sekunden: leises, kurzes Klopfen
  tick: {
    length: 90,
    notes: [
      {
        hz: 1174.66,
        at: 0,
        length: 90,
        attackMs: 1.5,
        decayMs: 16,
        level: 1,
        partials: [
          { ratio: 1, gain: 1 },
          { ratio: 2.4, gain: 0.08 },
        ],
      },
    ],
  },
  // Richtig: zwei helle Töne aufwärts (A5 → E6, Quinte)
  correct: {
    length: 380,
    notes: [
      { hz: 880, at: 0, length: 200, attackMs: 4, decayMs: 70, level: 0.85, partials: SOFT },
      { hz: 1318.51, at: 95, length: 285, attackMs: 4, decayMs: 105, level: 1, partials: SOFT },
    ],
  },
  // Falsch: zwei tiefe, hohle Töne abwärts (D#4 → C4) – kein Summer
  wrong: {
    length: 360,
    notes: [
      { hz: 311.13, at: 0, length: 200, attackMs: 6, decayMs: 70, level: 0.9, partials: HOLLOW },
      { hz: 261.63, at: 110, length: 250, attackMs: 6, decayMs: 95, level: 1, partials: HOLLOW },
    ],
  },
  // Kategorie gewählt / Unentschieden: ein ruhiger Glockenton (G5) mit kleinem Aufwärtsgleiten
  turn: {
    length: 320,
    notes: [
      { hz: 783.99, fromHz: 740, glideMs: 30, at: 0, length: 320, attackMs: 5, decayMs: 95, level: 1, partials: BELL },
    ],
  },
  // Gewonnen: Dur-Arpeggio aufwärts (C5 E5 G5 C6)
  win: {
    length: 400,
    notes: [
      { hz: 523.25, at: 0, length: 170, attackMs: 4, decayMs: 55, level: 0.75, partials: SOFT },
      { hz: 659.25, at: 60, length: 170, attackMs: 4, decayMs: 55, level: 0.8, partials: SOFT },
      { hz: 783.99, at: 120, length: 180, attackMs: 4, decayMs: 60, level: 0.85, partials: SOFT },
      { hz: 1046.5, at: 180, length: 220, attackMs: 4, decayMs: 85, level: 1, partials: SOFT },
    ],
  },
  // Verloren: weich abwärts in Moll (G4 D#4 C4)
  lose: {
    length: 400,
    notes: [
      { hz: 392, at: 0, length: 180, attackMs: 6, decayMs: 65, level: 0.85, partials: HOLLOW },
      { hz: 311.13, at: 110, length: 180, attackMs: 6, decayMs: 65, level: 0.9, partials: HOLLOW },
      { hz: 261.63, at: 220, length: 180, attackMs: 6, decayMs: 70, level: 1, partials: HOLLOW },
    ],
  },
};

/** Ausblenden am Ende jeder Note und des ganzen Sounds (keine Knackser beim Abschneiden). */
const FADE_OUT_MS = 12;

function samples(ms: number): number {
  return Math.round((ms / 1000) * SAMPLE_RATE);
}

/** Momentanfrequenz einer Note nach `t` Sekunden (lineares Gleiten von `fromHz` zum Grundton). */
function frequencyAt(note: Note, t: number): number {
  if (note.fromHz === undefined || !note.glideMs) return note.hz;
  const progress = Math.min(1, (t * 1000) / note.glideMs);
  return note.fromHz + (note.hz - note.fromHz) * progress;
}

/** Synthetisiert einen Sound als Float-Samples (−1 … 1), auf {@link PEAK_DBFS} normiert. */
export function synthesize(design: SoundDesign): Float32Array {
  if (design.length > MAX_DURATION_MS) throw new Error(`Sound länger als ${MAX_DURATION_MS} ms`);
  const output = new Float32Array(samples(design.length));
  for (const note of design.notes) {
    const start = samples(note.at);
    const length = Math.min(samples(note.length), output.length - start);
    const attack = Math.max(1, samples(note.attackMs));
    const fade = samples(FADE_OUT_MS);
    // Phase je Teilton aufsummieren (Gleiten ohne Phasensprünge)
    const phases = note.partials.map(() => 0);
    for (let index = 0; index < length; index++) {
      const t = index / SAMPLE_RATE;
      const rise = index < attack ? index / attack : 1;
      const decay = Math.exp(-(t * 1000) / note.decayMs);
      const tail = index > length - fade ? (length - index) / fade : 1;
      const base = frequencyAt(note, t);
      let value = 0;
      note.partials.forEach((partial, position) => {
        phases[position] = (phases[position] ?? 0) + (2 * Math.PI * base * partial.ratio) / SAMPLE_RATE;
        value += Math.sin(phases[position] ?? 0) * partial.gain;
      });
      const target = start + index;
      output[target] = (output[target] ?? 0) + value * rise * decay * tail * note.level;
    }
  }
  // Gesamt-Ausblendung und Normierung auf den Spitzenpegel
  const fade = samples(FADE_OUT_MS);
  let peak = 0;
  for (let index = 0; index < output.length; index++) {
    const remaining = output.length - index;
    if (remaining < fade) output[index] = (output[index] ?? 0) * (remaining / fade);
    peak = Math.max(peak, Math.abs(output[index] ?? 0));
  }
  const gain = peak > 0 ? 10 ** (PEAK_DBFS / 20) / peak : 0;
  for (let index = 0; index < output.length; index++) output[index] = (output[index] ?? 0) * gain;
  return output;
}

/** Spitzenpegel in dBFS (für Prüfungen). */
export function peakDbfs(data: Float32Array): number {
  let peak = 0;
  for (const value of data) peak = Math.max(peak, Math.abs(value));
  return peak === 0 ? Number.NEGATIVE_INFINITY : 20 * Math.log10(peak);
}

/** 16-Bit-PCM-WAV (mono) aus Float-Samples. */
export function encodeWav(data: Float32Array): Buffer {
  const bytesPerSample = 2;
  const buffer = Buffer.alloc(44 + data.length * bytesPerSample);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + data.length * bytesPerSample, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16); // Größe des fmt-Blocks
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * bytesPerSample, 28);
  buffer.writeUInt16LE(bytesPerSample, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(data.length * bytesPerSample, 40);
  data.forEach((value, index) => {
    const clamped = Math.max(-1, Math.min(1, value));
    buffer.writeInt16LE(Math.round(clamped * 0x7fff), 44 + index * bytesPerSample);
  });
  return buffer;
}

// ---------------------------------------------------------------------------------------------------
// Kodierung (ein einmaliger Container) und Prüfung
// ---------------------------------------------------------------------------------------------------

/** ffmpeg-Argumente: alle WAVs als Eingänge, je Sound eine .webm (Opus 48 kbit/s) und eine .mp3 (64 kbit/s). */
function ffmpegArgs(): string[] {
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y"];
  for (const name of SOUND_NAMES) args.push("-i", `${name}.wav`);
  SOUND_NAMES.forEach((name, input) => {
    const common = ["-map", `${input}:a`, "-ac", "1", "-map_metadata", "-1", "-fflags", "+bitexact"];
    args.push(...common, "-c:a", "libopus", "-b:a", "48k", "-vbr", "on", "-application", "audio", `${name}.webm`);
    args.push(...common, "-c:a", "libmp3lame", "-b:a", "64k", "-id3v2_version", "0", `${name}.mp3`);
  });
  return args;
}

function encode(workDir: string): void {
  const user = typeof process.getuid === "function" ? [`--user`, `${process.getuid()}:${process.getgid?.() ?? 0}`] : [];
  const result = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--network",
      "none",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--read-only",
      ...user,
      "-v",
      `${workDir}:/work`,
      "-w",
      "/work",
      FFMPEG_IMAGE,
      ...ffmpegArgs(),
    ],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
  if (result.error) throw new Error(`docker nicht ausführbar: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`ffmpeg im Container fehlgeschlagen (Exit ${result.status ?? "Signal"})`);
}

const LICENSE = `# Sounds – Lizenz

Die Dateien in diesem Ordner sind **eigene Synthesen** dieses Projekts – Sinus-Teiltöne mit weicher Hüllkurve,
erzeugt von \`apps/web/scripts/generate-sounds.ts\` (keine Samples, keine fremden Aufnahmen):

${SOUND_NAMES.map((name) => `- \`${name}.webm\`, \`${name}.mp3\``).join("\n")}

Sie stehen unter **CC0 1.0 Universal** (Public Domain Dedication):
https://creativecommons.org/publicdomain/zero/1.0/deed.de – Nutzung, Änderung und Weitergabe ohne
Bedingungen und ohne Namensnennung.

Technische Daten (docs/09 §10): je Sound höchstens ${MAX_DURATION_MS} ms, Spitzenpegel ${PEAK_DBFS} dBFS,
höchstens ${MAX_FILE_BYTES / 1024} KB je Datei; Opus 48 kbit/s in WebM und MP3 64 kbit/s, mono.
Kodiert mit ffmpeg aus dem Image \`${FFMPEG_IMAGE}\`.
`;

interface CheckProblem {
  file: string;
  problem: string;
}

/** Prüft die ausgelieferten Dateien: vorhanden, nicht leer, ≤ 20 KB, Lizenz vorhanden. */
export function checkSounds(directory: string): CheckProblem[] {
  const problems: CheckProblem[] = [];
  for (const name of SOUND_NAMES) {
    for (const extension of ["webm", "mp3"]) {
      const file = path.join(directory, `${name}.${extension}`);
      if (!existsSync(file)) {
        problems.push({ file, problem: "fehlt" });
        continue;
      }
      const size = statSync(file).size;
      if (size === 0) problems.push({ file, problem: "leer" });
      if (size > MAX_FILE_BYTES) problems.push({ file, problem: `${size} Bytes > ${MAX_FILE_BYTES}` });
    }
  }
  const license = path.join(directory, "LICENSE.md");
  if (!existsSync(license) || !readFileSync(license, "utf8").includes("CC0")) {
    problems.push({ file: license, problem: "Lizenz fehlt" });
  }
  return problems;
}

function report(problems: readonly CheckProblem[]): void {
  if (problems.length === 0) {
    console.info(`generate-sounds – ${SOUND_NAMES.length * 2} Dateien in ${path.relative(webRoot, outDir)} in Ordnung`);
    return;
  }
  for (const { file, problem } of problems)
    console.error(`generate-sounds – ${path.relative(webRoot, file)}: ${problem}`);
  process.exitCode = 1;
}

function generate(): void {
  const workDir = mkdtempSync(path.join(tmpdir(), "qm-sounds-"));
  try {
    for (const name of SOUND_NAMES) {
      const data = synthesize(SOUND_DESIGNS[name]);
      const level = peakDbfs(data);
      if (level > PEAK_DBFS + 0.01) throw new Error(`${name}: Spitzenpegel ${level.toFixed(2)} dBFS`);
      writeFileSync(path.join(workDir, `${name}.wav`), encodeWav(data));
      console.info(`generate-sounds – ${name}: ${SOUND_DESIGNS[name].length} ms, Spitze ${level.toFixed(1)} dBFS`);
    }
    encode(workDir);
    mkdirSync(outDir, { recursive: true });
    for (const name of SOUND_NAMES) {
      for (const extension of ["webm", "mp3"]) {
        const file = `${name}.${extension}`;
        copyFileSync(path.join(workDir, file), path.join(outDir, file));
        console.info(`generate-sounds – ${file}: ${statSync(path.join(outDir, file)).size} Bytes`);
      }
    }
    writeFileSync(path.join(outDir, "LICENSE.md"), LICENSE);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
  report(checkSounds(outDir));
}

if (import.meta.main) {
  if (process.argv.includes("--check")) report(checkSounds(outDir));
  else generate();
}
