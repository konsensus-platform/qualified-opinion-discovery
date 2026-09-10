// The recorded shape of one public-opinion research run. Everything a later
// independent verifier would need to check is recorded here verbatim: the exact
// prompt that was sent, every provider exchange including whatever reasoning the
// provider returned, every tool call this runtime executed, and the final
// structured output. This package records; it does not attest. See
// docs/architecture.md for what a stored transcript does and does not establish.
import { z } from "zod";

const text = (max: number) => z.string().trim().min(1).max(max);
const httpsUrl = z
  .string()
  .url()
  .refine((value) => value.startsWith("https://"), "Only HTTPS sources");

export const researchToolCallSchema = z
  .discriminatedUnion("name", [
    z
      .object({
        id: text(120),
        name: z.literal("search"),
        arguments: z.object({ query: text(300) }).strict(),
      })
      .strict(),
    z
      .object({
        id: text(120),
        name: z.literal("fetch"),
        arguments: z.object({ url: httpsUrl }).strict(),
      })
      .strict(),
  ])
  .describe("A tool call requested by the model and executed by this runtime");

export type ResearchToolCall = z.infer<typeof researchToolCallSchema>;

export const researchToolResultSchema = z
  .object({
    id: text(120),
    name: z.enum(["search", "fetch"]),
    ok: z.boolean(),
    result: z.unknown(),
    error: z.string().max(2000).nullable(),
  })
  .strict();

export type ResearchToolResult = z.infer<typeof researchToolResultSchema>;

// Providers expose very different things under the word "reasoning". Recording
// the kind keeps a summary from being presented later as a full trace.
export const researchReasoningSchema = z
  .object({
    kind: z.enum([
      "provider_reasoning_text",
      "provider_reasoning_summary",
      "assistant_visible_text",
    ]),
    // Generous on purpose. A reasoning model can return tens of thousands of
    // characters, and a bound a real provider crosses would cost the whole run.
    text: text(200_000),
  })
  .strict();

export type ResearchReasoning = z.infer<typeof researchReasoningSchema>;

export const researchMessageSchema = z
  .object({
    role: z.enum(["system", "user", "assistant", "tool"]),
    content: z.string().max(60_000),
    toolCallId: text(120).optional(),
    toolCalls: z.array(researchToolCallSchema).max(20).optional(),
  })
  .strict();

export type ResearchMessage = z.infer<typeof researchMessageSchema>;

export const researchFindingSchema = z
  .object({
    url: httpsUrl,
    title: text(300),
    // Who the model believes made the statement. Never a verified credential:
    // qualification is asserted by a human reviewer, not by this run.
    claimedAuthorLabel: text(200),
    quotedStatement: text(1200),
    relevance: text(1000),
    foundVia: z.array(text(300)).min(1).max(20),
    // True only when this runtime itself fetched the page during this run.
    fetchedByRuntime: z.boolean(),
  })
  .strict();

export type ResearchFinding = z.infer<typeof researchFindingSchema>;

export const researchOutputSchema = z
  .object({
    findings: z.array(researchFindingSchema).max(50),
    // The model's own words about how far it looked. Recorded because it was
    // said, not because it is evidence; nothing here establishes coverage.
    unverifiedCoverageClaim: text(2000),
  })
  .strict();

export type ResearchOutput = z.infer<typeof researchOutputSchema>;

export const researchStepSchema = z
  .object({
    index: z.number().int().nonnegative(),
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime(),
    request: z
      .object({
        system: z.string().max(60_000),
        messages: z.array(researchMessageSchema).max(200),
        toolNames: z.array(z.enum(["search", "fetch"])).max(8),
      })
      .strict(),
    reasoning: z.array(researchReasoningSchema).max(20),
    toolCalls: z.array(researchToolCallSchema).max(20),
    toolResults: z.array(researchToolResultSchema).max(20),
    output: researchOutputSchema.nullable(),
    // The provider response exactly as received, before any interpretation.
    rawResponse: z.unknown(),
  })
  .strict();

export type ResearchStep = z.infer<typeof researchStepSchema>;

export const researchLimitsSchema = z
  .object({
    maxSteps: z.number().int().min(1).max(20),
    maxSearches: z.number().int().min(1).max(50),
    maxFetches: z.number().int().min(1).max(50),
  })
  .strict();

export type ResearchLimits = z.infer<typeof researchLimitsSchema>;

export const researchTranscriptSchema = z
  .object({
    runId: z.string().uuid(),
    instanceId: text(80),
    profileRevision: z.number().int().positive(),
    questionId: text(80),
    promptTemplate: z.object({ id: text(80), version: text(20) }).strict(),
    // The exact strings sent to the provider on the first turn.
    prompt: z
      .object({ system: z.string().max(60_000), user: z.string().max(60_000) })
      .strict(),
    model: z
      .object({
        provider: text(80),
        name: text(120),
        parameters: z.record(z.unknown()),
      })
      .strict(),
    limits: researchLimitsSchema,
    steps: z.array(researchStepSchema).max(20),
    // The model's final structured output exactly as it was returned and parsed.
    // Never edited: the two fields below hold this runtime's adjudication of it.
    output: researchOutputSchema.nullable(),
    // Findings this runtime accepted. `fetchedByRuntime` here is set from this
    // runtime's own fetch log, not from the model's claim about itself, and a
    // fetched finding's quote has been checked against the text actually
    // retrieved. Unfetched findings are kept as leads with unchecked quotes.
    acceptedFindings: z.array(researchFindingSchema).max(50),
    droppedFindings: z
      .array(
        z.object({ url: z.string().max(2048), reason: text(300) }).strict(),
      )
      .max(50),
    status: z.enum(["finished", "failed"]),
    error: z.string().max(2000).nullable(),
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime(),
  })
  .strict();

export type ResearchTranscript = z.infer<typeof researchTranscriptSchema>;
