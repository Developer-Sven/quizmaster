import { afterEach, describe, expect, it, vi } from "vitest";
import { canScan, lobbyCodeFromScan, ScanError, startQrScan } from "./qr-scan";

const ORIGIN = "https://quizmaster.example";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("lobbyCodeFromScan (ADR-039)", () => {
  it("liest Einladungslinks dieser Origin und reine Codes", () => {
    expect(lobbyCodeFromScan(`${ORIGIN}/j/ABC234`, ORIGIN)).toBe("ABC234");
    expect(lobbyCodeFromScan(`  ${ORIGIN}/j/abc234/  `, ORIGIN)).toBe("ABC234");
    expect(lobbyCodeFromScan(`${ORIGIN}/j/ABC%20234?utm=x#y`, ORIGIN)).toBe("ABC234");
    expect(lobbyCodeFromScan("ABC 234", ORIGIN)).toBe("ABC234");
    expect(lobbyCodeFromScan("abc-234", ORIGIN)).toBe("ABC234");
  });

  it("ignoriert fremde Origins, andere Pfade und Unvollständiges – nie eine fremde Adresse übernehmen", () => {
    expect(lobbyCodeFromScan("https://evil.example/j/ABC234", ORIGIN)).toBeNull();
    expect(lobbyCodeFromScan("http://quizmaster.example/j/ABC234", ORIGIN)).toBeNull();
    expect(lobbyCodeFromScan(`${ORIGIN}/lobby/ABC234`, ORIGIN)).toBeNull();
    expect(lobbyCodeFromScan(`${ORIGIN}/j/ABC23`, ORIGIN)).toBeNull();
    expect(lobbyCodeFromScan(`${ORIGIN}/j/%E0%A4%A`, ORIGIN)).toBeNull();
    expect(lobbyCodeFromScan("WIFI:S:Netz;T:WPA;P:geheim;;", ORIGIN)).toBeNull();
    expect(lobbyCodeFromScan("", ORIGIN)).toBeNull();
  });
});

describe("startQrScan", () => {
  it("ohne Kamera-API (unsicherer Kontext, alter Browser): unsupported", async () => {
    vi.stubGlobal("navigator", {});
    expect(canScan()).toBe(false);
    await expect(startQrScan({} as HTMLVideoElement, () => undefined)).rejects.toMatchObject({ kind: "unsupported" });
  });

  it("Kamera verweigert bzw. nicht vorhanden → denied bzw. no-camera", async () => {
    const fail = (name: string) => Object.assign(new Error(name), { name });
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: () => Promise.reject(fail("NotAllowedError")) } });
    await expect(startQrScan({} as HTMLVideoElement, () => undefined)).rejects.toMatchObject({ kind: "denied" });
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: () => Promise.reject(fail("NotFoundError")) } });
    const error = await startQrScan({} as HTMLVideoElement, () => undefined).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ScanError);
    expect((error as ScanError).kind).toBe("no-camera");
  });

  it("nativer BarcodeDetector: meldet erkannten Text, stop() beendet Kamera und Schleife", async () => {
    vi.useFakeTimers();
    const stopTrack = vi.fn();
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: () => Promise.resolve({ getTracks: () => [{ stop: stopTrack }] }) },
    });
    let calls = 0;
    class FakeDetector {
      static getSupportedFormats() {
        return Promise.resolve(["qr_code"]);
      }
      detect() {
        calls++;
        return Promise.resolve(calls === 2 ? [{ rawValue: `${ORIGIN}/j/ABC234` }] : []);
      }
    }
    vi.stubGlobal("BarcodeDetector", FakeDetector);
    const video = { play: () => Promise.resolve(), srcObject: null as unknown, muted: false, playsInline: false };
    const texts: string[] = [];
    const session = await startQrScan(video as unknown as HTMLVideoElement, (text) => texts.push(text));
    expect(video.muted && video.playsInline).toBe(true);
    await vi.advanceTimersByTimeAsync(450);
    expect(texts).toEqual([`${ORIGIN}/j/ABC234`]);
    session.stop();
    const after = calls;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toBe(after);
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(video.srcObject).toBeNull();
    vi.useRealTimers();
  });
});
