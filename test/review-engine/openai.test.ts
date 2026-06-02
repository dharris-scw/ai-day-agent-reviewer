import test from "node:test";
import assert from "node:assert/strict";

import { OpenAiReviewModel } from "../../src/review-engine/openai.js";

test("requires OPENAI_API_KEY and OPENAI_MODEL", () => {
  assert.throws(() => new OpenAiReviewModel({ apiKey: "", model: "gpt-4.1-mini" }), /OPENAI_API_KEY/);
  assert.throws(() => new OpenAiReviewModel({ apiKey: "test-key", model: "" }), /OPENAI_MODEL/);
});

test("retries once when structured output fails validation", async () => {
  const responses = [
    {
      ok: true,
      status: 200,
      async json() {
        return {
          output_text: JSON.stringify({ wrong: true }),
        };
      },
    },
    {
      ok: true,
      status: 200,
      async json() {
        return {
          output_text: JSON.stringify({ summary: "Looks fine.", topRisks: ["Auth remains sensitive."] }),
        };
      },
    },
  ];

  let callCount = 0;
  const model = new OpenAiReviewModel({
    apiKey: "test-key",
    model: "gpt-4.1-mini",
    fetch: async (_input, init) => {
      callCount += 1;
      const parsed = JSON.parse(String(init?.body));
      assert.equal(parsed.text.format.type, "json_schema");
      return responses[callCount - 1] as Response;
    },
  });

  const result = await model.generateStructured({
    system: "Return JSON.",
    user: "Summarize.",
    schemaName: "summary",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["summary", "topRisks"],
      properties: {
        summary: { type: "string" },
        topRisks: { type: "array", items: { type: "string" } },
      },
    },
    validate(value) {
      if (!value || typeof value !== "object" || !("summary" in value)) {
        throw new Error("invalid");
      }

      return value as { summary: string; topRisks: string[] };
    },
  });

  assert.equal(callCount, 2);
  assert.equal(result.summary, "Looks fine.");
});
