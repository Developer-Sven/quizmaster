import { ErrorView } from "@/components/app/error-view";
import { errorText } from "@/lib/client/errors";

/** Ungültiger Code im Kurzlink (docs/09 §6): „Lobby nicht gefunden.“ + „Zur Startseite“. */
export default function JoinNotFound() {
  return <ErrorView testId="lobby-not-found" message={errorText("LOBBY_NOT_FOUND")} />;
}
