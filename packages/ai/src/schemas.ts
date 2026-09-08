// Adapted from Konsensus classification schemas; changed for neutral profiles
// and mandatory review. See PUBLICATION-PROVENANCE.json and NOTICE.md.
import { z } from "zod";

export const classifierInputSchema = z
  .object({
    statementText: z.string().trim().min(1).max(2400),
    questionText: z.string().min(1),
    locale: z.string().min(1),
    choices: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            slug: z.string().min(1),
            label: z.string().min(1),
            description: z.string().optional(),
            mockKeywords: z.array(z.string().min(1)),
          })
          .strict(),
      )
      .min(2),
  })
  .strict();

export const classificationOutputSchema = z
  .object({
    suggested_choice_id: z.string().uuid().optional(),
    choice_slug: z.string().min(1).optional(),
    confidence_score: z.number().min(0).max(1),
    confidence_label: z.enum(["low", "medium", "high"]),
    evidence_excerpt: z.string().min(1),
    rationale: z.string().min(1),
    alternative_choices: z
      .array(
        z
          .object({
            choice_slug: z.string().optional(),
            choice_id: z.string().uuid().optional(),
            reason: z.string(),
          })
          .strict(),
      )
      .default([]),
    should_count: z.boolean(),
    requires_human_review: z.literal(true),
  })
  .strict();

export type ClassifierInput = z.infer<typeof classifierInputSchema>;
export type ClassificationOutput = z.infer<typeof classificationOutputSchema>;
