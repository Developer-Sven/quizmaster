/** Nutzlast für Discord- und Slack-Webhooks: `content` (Discord) und `text` (Slack) mit gleichem Inhalt. */
export interface AlertPayload {
  content: string;
  text: string;
}

/** Discord erlaubt 2000 Zeichen; Massen-Erwähnungen (@everyone/@here/@channel) werden entschärft. */
export function alertPayload(message: string, host: string): AlertPayload {
  const safe = message
    .replace(/@(everyone|here|channel)/gi, "(at)$1")
    .replace(/\s+/g, " ")
    .trim();
  const text = `quizmaster (${host}): ${safe}`.slice(0, 1900);
  return { content: text, text };
}
