import { describe, expect, it } from "vitest";
import { CrownIcon, LogOutIcon, RefreshCwIcon, Settings2Icon } from "@/lib/ui/icons";
import { toastIcon } from "./live-toasts";

describe("Toast-Icons der Hinweise (docs/09 §7.10, §9)", () => {
  it("nutzt für jeden Hinweis ein Icon aus der Tabelle in docs/09 §9", () => {
    expect(toastIcon("hostChanged")).toBe(CrownIcon);
    expect(toastIcon("playerResigned")).toBe(LogOutIcon);
    expect(toastIcon("serverRestart")).toBe(RefreshCwIcon);
    // Vorschläge (ADR-053): `settings-2` wie der Abschnitt „Vorschläge“ in der Lobby
    expect(toastIcon("suggestion")).toBe(Settings2Icon);
    // „Der Host hat das Spiel beendet.“ (ADR-051): `crown` = Host
    expect(toastIcon("gameEnded")).toBe(CrownIcon);
  });

  it("lässt eigene Bestätigungen und Fehler beim Standard der Toast-Komponente (check bzw. triangle-alert)", () => {
    expect(toastIcon("info")).toBeUndefined();
    expect(toastIcon("error")).toBeUndefined();
  });
});
