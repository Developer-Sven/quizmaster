/**
 * Lädt den Realtime-Client erst bei Bedarf (Start- und Beitreten-Seite, docs/07: Socket.IO gehört nicht
 * ins Start-Bundle). Außerhalb von Komponenten, weil der React Compiler `import()` im Render nicht kennt.
 */
import type { RealtimeClient } from "./realtime-client";

export async function loadRealtimeClient(realtimeUrl: string): Promise<RealtimeClient> {
  const { getRealtimeClient } = await import("./realtime-client");
  return getRealtimeClient({ realtimeUrl });
}

/** Lädt das Modul vorab (Fokus im Formular, erste Code-Eingabe), damit der Klick danach nicht wartet. */
export function warmUpRealtimeClient(): void {
  import("./realtime-client").catch((error: unknown) => {
    console.warn("Realtime-Client konnte nicht vorgeladen werden:", error instanceof Error ? error.name : "unbekannt");
  });
}
