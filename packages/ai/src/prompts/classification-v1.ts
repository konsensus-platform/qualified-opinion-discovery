// Adapted from Konsensus classificationPromptV1: removed jurisdiction-specific
// application assumptions. This is a public policy template, not an LLM trace.
export const classificationPromptV1 = {
  name: "closed_choice_statement_classifier",
  version: "v1",
  purpose:
    "Map one source-linked public statement to one closed-ended answer choice.",
  publicPromptText:
    "Read the public statement, choose the closest closed answer, quote the evidence excerpt, explain the mapping, and require human review before counting.",
} as const;
