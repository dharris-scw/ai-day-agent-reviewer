import { planReviewCoverage } from "./coverage.js";
import {
  buildReviewSummary,
  calibrateFindings,
  dedupeFindings,
  filterFindingsByReviewLevel,
  formatFindingForDisplay,
  resolveReviewLevel,
} from "./normalize.js";
import { OpenAiReviewModel } from "./openai.js";
import {
  buildFileReviewSystemPrompt,
  buildFileReviewUserPrompt,
  buildRepositoryBriefSystemPrompt,
  buildRepositoryBriefUserPrompt,
  buildSynthesisSystemPrompt,
  buildSynthesisUserPrompt,
} from "./prompts.js";
import type {
  PullRequestReviewInput,
  RepositoryBrief,
  ReviewEngineModel,
  ReviewResult,
} from "./types.js";
import {
  fileReviewSchema,
  repositoryBriefSchema,
  synthesisSchema,
  validateFileReview,
  validateRepositoryBrief,
  validateSynthesis,
} from "./validation.js";

export async function reviewPullRequest(
  input: PullRequestReviewInput,
  model: ReviewEngineModel = new OpenAiReviewModel(),
): Promise<ReviewResult> {
  const reviewLevel = resolveReviewLevel(input.reviewLevel);
  const coverage = planReviewCoverage(input.changedFiles, input.coverage);
  const selectedFiles = input.changedFiles.filter((file) => coverage.reviewedPaths.includes(file.path));

  const repositoryBrief = await generateRepositoryBrief(input, coverage, model);
  const rawFindings = (
    await Promise.all(
      selectedFiles.map(async (file) => {
        const response = await model.generateStructured({
          system: buildFileReviewSystemPrompt(reviewLevel),
          user: buildFileReviewUserPrompt(file, coverage, repositoryBrief, reviewLevel),
          schemaName: "review_file_findings",
          schema: fileReviewSchema,
          validate: validateFileReview,
          retryHint:
            "Each finding must include path, line, severity, title, body, and category. Use null for file-level comments.",
        });

        return response.findings;
      }),
    )
  ).flat();

  const findings = filterFindingsByReviewLevel(calibrateFindings(dedupeFindings(rawFindings)), reviewLevel);

  const synthesis = await model.generateStructured({
    system: buildSynthesisSystemPrompt(reviewLevel),
    user: buildSynthesisUserPrompt(
      input,
      coverage,
      reviewLevel,
      findings.map((finding) => `- ${formatFindingForDisplay(finding)} @ ${finding.path}:${finding.line ?? "file"}`).join("\n"),
    ),
    schemaName: "review_synthesis",
    schema: synthesisSchema,
    validate: validateSynthesis,
    retryHint: "Provide a concise summary string and an array of top risk strings.",
  });

  return {
    coverage,
    findings,
    summary: buildReviewSummary(findings, synthesis.summary, coverage.note, synthesis.topRisks),
  };
}

async function generateRepositoryBrief(
  input: PullRequestReviewInput,
  coverage: ReviewResult["coverage"],
  model: ReviewEngineModel,
): Promise<RepositoryBrief> {
  return model.generateStructured({
    system: buildRepositoryBriefSystemPrompt(),
    user: buildRepositoryBriefUserPrompt(input, coverage),
    schemaName: "repository_brief",
    schema: repositoryBriefSchema,
    validate: validateRepositoryBrief,
    retryHint: "Return arrays for architectureNotes and riskAreas.",
  });
}
