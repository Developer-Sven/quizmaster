/** Ohne React-Importe: wird vom Root-Layout (Server-Komponente) eingebunden (ADR-040). */

/**
 * Inline im Root-Layout (mit CSP-Nonce, ohne Daten): fängt `beforeinstallprompt` ab, bevor React lädt – ohne die
 * Mini-Infobar von Chrome; die Zeile auf der Startseite ruft später `prompt()` auf.
 */
export const EARLY_INSTALL_CAPTURE_SCRIPT =
  'window.__qmInstallPrompt=null;window.addEventListener("beforeinstallprompt",function(e){e.preventDefault();window.__qmInstallPrompt=e;});';
