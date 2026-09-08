import type { InstanceProfile } from "@discovery/config";
import type { Classifier, ClassificationOutput } from "@discovery/ai";
import type { CrawledPage } from "@discovery/crawler";
import { z } from "zod";

export type Job = {
  id: string;
  questionId: string;
  seedUrl: string;
  status: "queued" | "running" | "finished" | "failed";
  attempts: number;
  error: string | null;
  profile: InstanceProfile;
};
export type DiscoveryResult = {
  page: CrawledPage;
  classification?: {
    method: Classifier["id"];
    promptVersion: string;
    output: ClassificationOutput;
  };
};
const reviewBase = {
  statementId: z.string().uuid(),
  expectedRevision: z.number().int().nonnegative(),
  reviewer: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(1).max(2000),
};
export const reviewInputSchema = z.discriminatedUnion("decision", [
  z
    .object({
      ...reviewBase,
      decision: z.literal("approved"),
      choiceId: z.string().uuid(),
      subjectLabel: z.string().trim().min(1).max(200),
      qualificationReference: z.string().trim().min(1).max(2000),
    })
    .strict(),
  z.object({ ...reviewBase, decision: z.literal("rejected") }).strict(),
]);
export type ReviewInput = z.infer<typeof reviewInputSchema>;

export interface DiscoveryStore {
  enqueue(
    profile: InstanceProfile,
    seedUrl: string,
    questionId: string,
  ): string;
  getJob(id: string): Job;
  claimJob(id: string): Job | null;
  finishJob(id: string, result: DiscoveryResult): void;
  failJob(id: string, error: string): void;
}
