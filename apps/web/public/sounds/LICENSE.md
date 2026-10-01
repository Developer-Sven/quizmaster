# Sounds – Lizenz

Die Dateien in diesem Ordner sind **eigene Synthesen** dieses Projekts – Sinus-Teiltöne mit weicher Hüllkurve,
erzeugt von `apps/web/scripts/generate-sounds.ts` (keine Samples, keine fremden Aufnahmen):

- `lock.webm`, `lock.mp3`
- `tick.webm`, `tick.mp3`
- `correct.webm`, `correct.mp3`
- `wrong.webm`, `wrong.mp3`
- `turn.webm`, `turn.mp3`
- `win.webm`, `win.mp3`
- `lose.webm`, `lose.mp3`

Sie stehen unter **CC0 1.0 Universal** (Public Domain Dedication):
https://creativecommons.org/publicdomain/zero/1.0/deed.de – Nutzung, Änderung und Weitergabe ohne
Bedingungen und ohne Namensnennung.

Technische Daten (docs/09 §10): je Sound höchstens 400 ms, Spitzenpegel -12 dBFS,
höchstens 20 KB je Datei; Opus 48 kbit/s in WebM und MP3 64 kbit/s, mono.
Kodiert mit ffmpeg aus dem Image `docker.io/mwader/static-ffmpeg:9.0.2@sha256:7d9bdaaf887f7e6ce6151f67325c344074b5ff1fb75316011c3376503e449a7b`.
