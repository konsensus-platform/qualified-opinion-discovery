// Adapted from Konsensus mockClassify; keyword rules now belong to the profile,
// ambiguity abstains, and questions are not treated as statement evidence.
import type { ClassificationOutput, ClassifierInput } from "./schemas";

export function mockClassify(input: ClassifierInput): ClassificationOutput {
  const text = input.statementText.toLocaleLowerCase(input.locale);
  const matches = input.choices.filter((choice) =>
    choice.mockKeywords.some((keyword) =>
      text.includes(keyword.toLocaleLowerCase(input.locale)),
    ),
  );
  const choice = matches.length === 1 ? matches[0] : undefined;
  return {
    suggested_choice_id: choice?.id,
    choice_slug: choice?.slug,
    confidence_score: choice ? 0.6 : 0,
    confidence_label: choice ? "medium" : "low",
    evidence_excerpt: input.statementText.slice(0, 280),
    rationale: choice
      ? "A configured keyword matched one answer. This is a deterministic demo classifier; human review is required."
      : "No unambiguous configured answer matched. Human review must determine any final answer.",
    alternative_choices: (choice
      ? input.choices.filter((c) => c.id !== choice.id)
      : matches
    ).map((c) => ({
      choice_id: c.id,
      choice_slug: c.slug,
      reason: "Consider during human review.",
    })),
    should_count: Boolean(choice),
    requires_human_review: true,
  };
}
