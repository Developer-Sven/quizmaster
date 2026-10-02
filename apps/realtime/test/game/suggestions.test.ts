/**
 * Vorschläge für die Einstellungen (ADR-053) über Socket.IO: vorschlagen, übernehmen in der Fassung des Hosts,
 * nur spielbare Kategorien, nur der Host entscheidet, Vorschläge aus.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { TestClient, TestServer } from "../helpers/index.ts";
import { connectGuest, createLobby, joinLobby, startGameServer } from "./support.ts";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

let server: TestServer;

beforeAll(async () => {
  server = await startGameServer();
});
afterAll(() => server?.cleanup());

async function lobbyOfThree(): Promise<{ host: TestClient; ben: TestClient; lea: TestClient; close: () => void }> {
  const host = await connectGuest(server, { guestDoc: true });
  const code = await createLobby(host);
  const ben = await connectGuest(server, { guestDoc: true });
  await joinLobby(ben, code, "Ben");
  const lea = await connectGuest(server, { guestDoc: true });
  await joinLobby(lea, code, "Lea");
  return {
    host,
    ben,
    lea,
    close: () => {
      for (const client of [host, ben, lea]) client.close();
    },
  };
}

describe("Vorschläge für die Einstellungen (ADR-053)", () => {
  it("Ben schlägt vor, der Host sieht den offenen Vorschlag und übernimmt ihn angepasst", async () => {
    const { host, ben, close } = await lobbyOfThree();
    const pending = host.waitFor("lobby:state", (state) =>
      state.suggestions.some((entry) => entry.status === "pending"),
    );
    expect(await ben.emit("lobby:suggest-settings", { rounds: 5, answerSec: 30 })).toEqual({ ok: true, data: null });
    const [suggestion] = (await pending).suggestions;
    expect(suggestion).toMatchObject({ changes: { rounds: 5, answerSec: 30 }, status: "pending" });
    const accepted = ben.waitFor("lobby:state", (state) => state.suggestions[0]?.status === "accepted");
    expect(
      await host.emit("lobby:accept-suggestion", { id: suggestion?.id ?? "", changes: { rounds: 4, answerSec: 30 } }),
    ).toEqual({ ok: true, data: null });
    expect((await accepted).settings).toMatchObject({ rounds: 4, answerSec: 30 });
    close();
  });

  it("nur Kategorien aus dem Katalog, kein Vorschlag vom Host, nur der Host entscheidet, Vorschläge aus", async () => {
    const { host, ben, lea, close } = await lobbyOfThree();
    expect(await ben.emit("lobby:suggest-settings", { categoryIds: ["gibt-es-nicht"] })).toMatchObject({
      ok: false,
      error: { code: "INVALID_OPTION" },
    });
    expect(await host.emit("lobby:suggest-settings", { rounds: 5 })).toMatchObject({
      ok: false,
      error: { code: "INVALID_OPTION" },
    });
    expect(await ben.emit("lobby:suggest-settings", { allowSuggestions: false } as never)).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_FAILED" },
    });
    const pending = host.waitFor("lobby:state", (state) => state.suggestions.length === 1);
    expect((await ben.emit("lobby:suggest-settings", { rounds: 5 })).ok).toBe(true);
    const id = (await pending).suggestions[0]?.id ?? "";
    expect(await lea.emit("lobby:decline-suggestion", { id })).toMatchObject({
      ok: false,
      error: { code: "NOT_HOST" },
    });
    const cleared = ben.waitFor(
      "lobby:state",
      (state) => !state.settings.allowSuggestions && state.suggestions.length === 0,
    );
    expect((await host.emit("lobby:update-settings", { allowSuggestions: false })).ok).toBe(true);
    await cleared;
    expect(await ben.emit("lobby:suggest-settings", { rounds: 6 })).toMatchObject({
      ok: false,
      error: { code: "INVALID_OPTION" },
    });
    close();
  });
});
