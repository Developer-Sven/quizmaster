import type { MetadataRoute } from "next";
import { de } from "../i18n/de";
import { THEME_COLOR } from "../lib/ui/tokens";

/**
 * Web-App-Manifest (docs/10), ausgeliefert als `/manifest.webmanifest`; Next verlinkt es im `<head>`.
 * Icons erzeugt `scripts/generate-icons.ts` (public/icons), die Screenshots `scripts/generate-screenshots.ts`
 * (public/screenshots). Farben aus dem Token-Spiegel (`--color-bg`, Studio-Navy).
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: de.pwa.manifest.name,
    short_name: de.app.name,
    description: de.pwa.manifest.description,
    lang: "de",
    start_url: "/?source=pwa",
    scope: "/",
    display: "standalone",
    // keine feste Ausrichtung (ADR-035, WCAG 2.2 SC 1.3.4): Hochformat ist die Gestaltungsreferenz, Querformat
    // bleibt bedienbar (Flow-Modus für niedrige Viewports)
    background_color: THEME_COLOR,
    theme_color: THEME_COLOR,
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
        label: de.pwa.manifest.screenshotLobby,
      },
      {
        src: "/screenshots/frage.png",
        sizes: "1080x1920",
        type: "image/png",
        form_factor: "narrow",
        label: de.pwa.manifest.screenshotQuestion,
      },
    ],
    // Android/Chrome: Die Seite erkennt eine schon installierte App (`navigator.getInstalledRelatedApps`) und bietet
    // dann kein Installieren an (ADR-054). Die URL wird gegen die Manifest-Adresse aufgelöst.
    related_applications: [{ platform: "webapp", url: "/manifest.webmanifest" }],
    shortcuts: [
      { name: de.pwa.manifest.shortcutCreate, url: "/?action=create" },
      { name: de.pwa.manifest.shortcutJoin, url: "/?action=join" },
    ],
  };
}
