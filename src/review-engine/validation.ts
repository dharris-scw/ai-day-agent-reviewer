import type { FileReviewModelResponse, RepositoryBrief, ReviewFinding, SynthesisModelResponse } from "./types.js";
import { normalizeFinding } from "./normalize.js";

export const repositoryBriefSchema = {
  type: "object",
  additionalProperties: false,
  required: ["architectureNotes", "riskAreas"],
  properties: {
    architectureNotes: {
      type: "array",
      items: { type: "string" },
    },
    riskAreas: {
      type: "array",
      items: { type: "string" },
    },
  },
} as const;

export const fileReviewSchema = {
  type: "object",
  additionalProperties: false,
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "line", "severity", "title", "body", "category"],
        properties: {
          path: { type: "string" },
          line: { type: ["integer", "null"] },
          severity: { type: "string" },
          title: { type: "string" },
          body: { type: "string" },
          category: { type: "string" },
        },
      },
    },
  },
} as const;

export const synthesisSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "topRisks"],
  properties: {
    summary: { type: "string" },
    topRisks: {
      type: "array",
      items: { type: "string" },
    },
  },
} as const;

export function validateRepositoryBrief(value: unknown): RepositoryBrief {
  const record = asRecord(value);
  const architectureNotes = asStringArray(record.architectureNotes, "architectureNotes");
  const riskAreas = asStringArray(record.riskAreas, "riskAreas");
  return { architectureNotes, riskAreas };
}

export function validateFileReview(value: unknown): FileReviewModelResponse {
  const record = asRecord(value);
  const findingsValue = record.findings;
  if (!Array.isArray(findingsValue)) {
    throw new Error("findings must be an array");
  }

  return {
    findings: findingsValue.map(validateFinding),
  };
}

export function validateSynthesis(value: unknown): SynthesisModelResponse {
  const record = asRecord(value);
  const summary = asString(record.summary, "summary");
  const topRisks = asStringArray(record.topRisks, "topRisks");
  return { summary, topRisks };
}

function validateFinding(value: unknown): ReviewFinding {
  const record = asRecord(value);
  const line = record.line;
  if (line !== null && (!Number.isInteger(line) || (line as number) < 1)) {
    throw new Error("finding.line must be a positive integer or null");
  }

  return normalizeFinding({
    path: asString(record.path, "path"),
    line: line as number | null,
    severity: asString(record.severity, "severity") as ReviewFinding["severity"],
    title: asString(record.title, "title"),
    body: asString(record.body, "body"),
    category: asString(record.category, "category"),
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected object");
  }

  return value as Record<string, unknown>;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }

  return value;
}

function asStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array`);
  }

  return value.map((entry) => asString(entry, `${field}[]`));
}
