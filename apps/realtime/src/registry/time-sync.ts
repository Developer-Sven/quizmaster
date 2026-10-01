/**
 * `time:sync` (docs/05 §Uhrenabgleich): liefert die Serverzeit für den Offset-Abgleich des Clients
 * (`offset = serverNow − (t0 + rtt / 2)`, Median aus 5 Messungen). Limit: 10 je 10 s und Socket.
 */
import type { RealtimeModule } from "./types.ts";

export const timeSyncModule: RealtimeModule = {
  name: "time-sync",
  setup({ registerEvent, clock }) {
    registerEvent("time:sync", () => ({ serverNow: clock.now() }));
  },
};
