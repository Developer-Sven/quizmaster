/**
 * Erzeugt das JSON-Schema der Fragen-Dateien aus den zod-Schemas (`pnpm --filter @quizmaster/shared
 * gen:schema` → `packages/shared/schema/question-file.schema.json`). Bedingte Regeln (if/then) und
 * `uniqueItems` kann zod nicht selbst ausdrücken – sie werden hier gezielt ergänzt, sodass das Ergebnis
 * `content/schema/question-file.schema.json` entspricht.
 */
import { z } from "zod";
import {
  difficultySchema,
  questionAnswersSchema,
  questionFileEntrySchema,
  questionFileSchema,
  reviewInfoSchema,
  sourceUrlSchema,
} from "./questions.ts";

export const QUESTION_FILE_SCHEMA_ID = "https://quizmaster.example/schema/question-file.schema.json";
export const QUESTION_FILE_SCHEMA_TITLE = "quizmaster – Fragen-Datei (ein Thema)";

/** JSON-Schema-Objekt (Draft 2020-12). */
export type JsonSchemaObject = { [key: string]: unknown };

/** if/then-Regel des JSON-Schemas: hat `property` den Wert `value`, sind `required` Pflicht. */
function requireWhen(property: string, value: string | boolean, required: string[]): JsonSchemaObject {
  return {
    if: { required: [property], properties: { [property]: { const: value } } },
    // biome-ignore lint/suspicious/noThenProperty: JSON-Schema-Schlüsselwort (if/then), kein Promise-artiges Objekt.
    then: { required },
  };
}

const CONDITIONAL_RULES = [
  requireWhen("status", "approved", ["source", "review"]),
  requireWhen("status", "needs_fix", ["review"]),
  requireWhen("volatile", true, ["asOf"]),
];

const ISO_DATE = { type: "string", format: "date" };

export function buildQuestionFileJsonSchema(): JsonSchemaObject {
  const generated = z.toJSONSchema(questionFileSchema, {
    target: "draft-2020-12",
    override: (ctx) => {
      const json = ctx.jsonSchema as JsonSchemaObject;
      if (ctx.zodSchema === questionFileEntrySchema) {
        json.allOf = CONDITIONAL_RULES;
      } else if (ctx.zodSchema === questionAnswersSchema) {
        replaceContent(json, {
          type: "array",
          minItems: 4,
          maxItems: 4,
          items: { type: "string", minLength: 1, maxLength: 40 },
          description: "answers[0] ist die richtige Antwort",
          uniqueItems: true,
        });
      } else if (ctx.zodSchema === difficultySchema) {
        replaceContent(json, { type: "integer", minimum: 1, maximum: 5 });
      } else if (ctx.zodSchema === sourceUrlSchema) {
        replaceContent(json, { type: "string", pattern: "^https://" });
      } else if (ctx.zodSchema === reviewInfoSchema) {
        const properties = json.properties as JsonSchemaObject | undefined;
        if (properties) properties.checkedAt = ISO_DATE;
      } else if ("enum" in json || "const" in json) {
        // zod ergänzt "type": "string" neben enum/const – redundant, im Original nicht vorhanden.
        delete json.type;
      }
    },
  }) as JsonSchemaObject;

  const itemProperties = findQuestionItemProperties(generated);
  itemProperties.asOf = ISO_DATE;

  const { $schema, ...rest } = generated;
  return { $schema, $id: QUESTION_FILE_SCHEMA_ID, title: QUESTION_FILE_SCHEMA_TITLE, ...rest };
}

function replaceContent(target: JsonSchemaObject, content: JsonSchemaObject): void {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, content);
}

function findQuestionItemProperties(schema: JsonSchemaObject): JsonSchemaObject {
  const questions = (schema.properties as JsonSchemaObject | undefined)?.questions as JsonSchemaObject | undefined;
  const items = questions?.items as JsonSchemaObject | undefined;
  const properties = items?.properties as JsonSchemaObject | undefined;
  if (!properties) throw new Error("Unerwartete Struktur des erzeugten JSON-Schemas (questions.items.properties)");
  return properties;
}

/** Serialisiert wie die Datei im Repo (2 Leerzeichen, Zeilenumbruch am Ende). */
export function serializeJsonSchema(schema: JsonSchemaObject): string {
  return `${JSON.stringify(schema, null, 2)}\n`;
}
