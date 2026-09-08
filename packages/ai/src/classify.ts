// Adapted from Konsensus classifyStatement. Provider selection is explicit;
// the extracted baseline has a mock adapter only.
import { mockClassify } from "./mockClassifier";
import { classificationPromptV1 } from "./prompts/classification-v1";
import {
  classificationOutputSchema,
  classifierInputSchema,
  type ClassifierInput,
  type ClassificationOutput,
} from "./schemas";

export interface Classifier {
  readonly id: string;
  readonly promptVersion: string;
  classify(input: ClassifierInput): Promise<ClassificationOutput>;
}

export async function classifyStatement(
  input: ClassifierInput,
): Promise<ClassificationOutput> {
  return classificationOutputSchema.parse(
    mockClassify(classifierInputSchema.parse(input)),
  );
}

export const mockClassifier: Classifier = {
  id: "deterministic-mock-v1",
  promptVersion: classificationPromptV1.version,
  classify: classifyStatement,
};

export function validateClassification(
  input: ClassifierInput,
  value: unknown,
): ClassificationOutput {
  const output = classificationOutputSchema.parse(value);
  if (output.suggested_choice_id || output.choice_slug) {
    if (
      !input.choices.some(
        (c) =>
          c.id === output.suggested_choice_id && c.slug === output.choice_slug,
      )
    ) {
      throw new Error("Classifier suggested an answer outside this question");
    }
  } else if (output.should_count) {
    throw new Error("Classifier requested counting without an answer");
  }
  if (!input.statementText.includes(output.evidence_excerpt)) {
    throw new Error("Classifier evidence is not an excerpt of the statement");
  }
  for (const alternative of output.alternative_choices) {
    if (
      !input.choices.some(
        (c) =>
          c.id === alternative.choice_id && c.slug === alternative.choice_slug,
      )
    ) {
      throw new Error("Classifier alternative is outside this question");
    }
  }
  return output;
}
