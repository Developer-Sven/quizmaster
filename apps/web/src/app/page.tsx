import { PROTOCOL_VERSION } from "@quizmaster/shared";

export default function StartPage() {
  return (
    <main>
      <h1>quizmaster</h1>
      <p>Protokoll {PROTOCOL_VERSION}</p>
    </main>
  );
}
