/**
 * Erzeugt `packages/shared/schema/question-file.schema.json` aus den zod-Schemas (Quelle der Wahrheit:
 * `src/content/questions.ts`). Aufruf: `pnpm --filter @quizmaster/shared gen:schema`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildQuestionFileJsonSchema, serializeJsonSchema } from "../src/content/json-schema.ts";

const target = join(import.meta.dirname, "..", "schema", "question-file.schema.json");
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, serializeJsonSchema(buildQuestionFileJsonSchema()));
console.info(`JSON-Schema geschrieben: ${target}`);
