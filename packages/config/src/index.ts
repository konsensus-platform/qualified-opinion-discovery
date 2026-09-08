import { z } from "zod";

const identifier = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(80);
const nonempty = z.string().trim().min(1).max(1000);
const choiceSchema = z
  .object({
    id: z.string().uuid(),
    slug: identifier,
    label: nonempty,
    description: nonempty.optional(),
    mockKeywords: z.array(nonempty).max(30),
  })
  .strict();

export const questionSchema = z
  .object({
    id: identifier,
    text: nonempty,
    candidateTerms: z.array(nonempty).min(1).max(50),
    choices: z.array(choiceSchema).min(2).max(20),
  })
  .strict()
  .superRefine((question, ctx) => {
    for (const field of ["id", "slug"] as const) {
      if (
        new Set(question.choices.map((c) => c[field])).size !==
        question.choices.length
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Choice identifiers and slugs must be unique",
        });
      }
    }
  });

export const crawlerPolicySchema = z
  .object({
    userAgent: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*\/[0-9.]+$/),
    allowedHosts: z
      .array(z.string().regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/))
      .min(1)
      .max(100),
    maxResponseBytes: z
      .number()
      .int()
      .min(1024)
      .max(5_000_000)
      .default(1_000_000),
    timeoutMs: z.number().int().min(100).max(30_000).default(10_000),
    maxRedirects: z.number().int().min(0).max(5).default(3),
  })
  .strict();

export const instanceProfileSchema = z
  .object({
    id: identifier,
    revision: z.number().int().positive(),
    name: nonempty,
    locale: z
      .string()
      .max(35)
      .refine((v) => {
        try {
          return Intl.getCanonicalLocales(v).length === 1;
        } catch {
          return false;
        }
      }, "Use a valid BCP 47 locale"),
    qualificationLabel: nonempty,
    crawler: crawlerPolicySchema,
    questions: z.array(questionSchema).min(1).max(100),
  })
  .strict()
  .superRefine((profile, ctx) => {
    if (
      new Set(profile.questions.map((q) => q.id)).size !==
      profile.questions.length
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Question identifiers must be unique",
      });
    }
  });

export type InstanceProfile = z.infer<typeof instanceProfileSchema>;
export type Question = z.infer<typeof questionSchema>;
export type CrawlerPolicy = z.infer<typeof crawlerPolicySchema>;

export function parseProfile(value: unknown): InstanceProfile {
  return instanceProfileSchema.parse(value);
}

export async function loadProfile(path: string): Promise<InstanceProfile> {
  return parseProfile(await Bun.file(path).json());
}

export function getQuestion(profile: InstanceProfile, id: string): Question {
  const question = profile.questions.find((q) => q.id === id);
  if (!question) throw new Error("Question is not in this instance profile");
  return question;
}
