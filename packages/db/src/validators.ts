/**
 * `$jsonSchema`-Validator für `questions` (docs/04: Defense in Depth – 4 Antworten, Pflichtfelder,
 * Wertebereiche). Die fachliche Validierung passiert vorher mit zod; der Validator verhindert nur,
 * dass kaputte Dokumente überhaupt in die Datenbank gelangen.
 *
 * `validationLevel: "moderate"`: neue und gültige Dokumente werden geprüft; ein (theoretisch) bereits
 * ungültiges Altdokument blockiert dagegen keine Statistik-Updates – sonst würde die Transaktion beim
 * Spielabschluss an einer einzigen Altlast scheitern.
 */
import { DIFFICULTIES, FLAG_CODE_REGEX, SLUG_REGEX } from "@quizmaster/shared";
import { DISPLAY_ORDERS, QUESTION_DB_STATUSES, QUESTION_ID_REGEX, TOPIC_ID_REGEX } from "@quizmaster/shared/content";
import type { Document } from "mongodb";

const INTEGER = ["int", "long"];
const counter = { bsonType: INTEGER, minimum: 0 };

export const QUESTIONS_VALIDATOR: Document = {
  $jsonSchema: {
    bsonType: "object",
    required: [
      "_id",
      "category",
      "topic",
      "difficulty",
      "prompt",
      "answers",
      "displayOrder",
      "explanation",
      "media",
      "volatile",
      "asOf",
      "source",
      "status",
      "autoRetired",
      "lang",
      "contentHash",
      "version",
      "stats",
      "createdAt",
      "updatedAt",
    ],
    properties: {
      _id: { bsonType: "string", pattern: QUESTION_ID_REGEX.source },
      category: { bsonType: "string", maxLength: 64, pattern: SLUG_REGEX.source },
      topic: { bsonType: "string", maxLength: 100, pattern: TOPIC_ID_REGEX.source },
      difficulty: { bsonType: INTEGER, minimum: Math.min(...DIFFICULTIES), maximum: Math.max(...DIFFICULTIES) },
      prompt: { bsonType: "string", minLength: 1, maxLength: 500 },
      answers: {
        bsonType: "array",
        minItems: 4,
        maxItems: 4,
        items: { bsonType: "string", minLength: 1, maxLength: 200 },
      },
      displayOrder: { enum: [...DISPLAY_ORDERS] },
      explanation: { bsonType: ["string", "null"], maxLength: 500 },
      media: {
        oneOf: [
          { bsonType: "null" },
          {
            bsonType: "object",
            required: ["kind", "code"],
            additionalProperties: false,
            properties: {
              kind: { enum: ["flag"] },
              code: { bsonType: "string", pattern: FLAG_CODE_REGEX.source },
            },
          },
        ],
      },
      volatile: { bsonType: "bool" },
      asOf: { bsonType: ["string", "null"] },
      source: { bsonType: ["string", "null"] },
      status: { enum: [...QUESTION_DB_STATUSES] },
      autoRetired: {
        oneOf: [
          { bsonType: "null" },
          {
            bsonType: "object",
            required: ["reason", "at"],
            properties: { reason: { enum: ["reports", "rating"] }, at: { bsonType: "date" } },
          },
        ],
      },
      lang: { enum: ["de"] },
      contentHash: { bsonType: "string", pattern: "^[0-9a-f]{64}$" },
      version: { bsonType: INTEGER, minimum: 1 },
      stats: {
        bsonType: "object",
        required: ["shown", "correct", "likes", "dislikes", "reports"],
        properties: {
          shown: counter,
          correct: counter,
          likes: counter,
          dislikes: counter,
          reports: counter,
        },
      },
      createdAt: { bsonType: "date" },
      updatedAt: { bsonType: "date" },
    },
  },
};

export const QUESTIONS_VALIDATION_OPTIONS = {
  validationLevel: "moderate",
  validationAction: "error",
} as const;
