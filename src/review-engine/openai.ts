import type { ReviewEngineModel, StructuredGenerationRequest } from "./types.js";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

export interface OpenAiModelOptions {
  apiKey?: string;
  model?: string;
  fetch?: typeof fetch;
}

interface OpenAiResponsePayload {
  output_text?: string;
  output?: Array<{
    content?: Array<{
      type?: string;
      text?: string;
      json?: unknown;
    }>;
  }>;
}

export class OpenAiReviewModel implements ReviewEngineModel {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAiModelOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.OPENAI_API_KEY ?? "";
    this.model = options.model ?? process.env.OPENAI_MODEL ?? "";
    this.fetchImpl = options.fetch ?? fetch;

    if (!this.apiKey) {
      throw new Error("OPENAI_API_KEY is required");
    }

    if (!this.model) {
      throw new Error("OPENAI_MODEL is required");
    }
  }

  async generateStructured<T>(request: StructuredGenerationRequest<T>): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await this.fetchImpl(OPENAI_RESPONSES_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          input: [
            { role: "system", content: request.system },
            {
              role: "user",
              content:
                attempt === 0
                  ? request.user
                  : `${request.user}\n\nThe previous response did not satisfy the JSON schema. ${request.retryHint ?? "Return a corrected JSON object that matches the schema exactly."}`,
            },
          ],
          text: {
            format: {
              type: "json_schema",
              name: request.schemaName,
              strict: true,
              schema: request.schema,
            },
          },
        }),
      });

      if (!response.ok) {
        throw new Error(`OpenAI request failed with status ${response.status}`);
      }

      const payload = (await response.json()) as OpenAiResponsePayload;

      try {
        return request.validate(extractJson(payload));
      } catch (error) {
        lastError = error instanceof Error ? error : new Error("Failed to validate structured response");
      }
    }

    throw lastError ?? new Error("Failed to validate structured response");
  }
}

function extractJson(payload: OpenAiResponsePayload): unknown {
  if (payload.output_text) {
    return JSON.parse(payload.output_text);
  }

  for (const item of payload.output ?? []) {
    for (const content of item.content ?? []) {
      if (content.json !== undefined) {
        return content.json;
      }

      if (content.type === "output_text" && typeof content.text === "string") {
        return JSON.parse(content.text);
      }
    }
  }

  throw new Error("OpenAI response did not include structured output");
}
