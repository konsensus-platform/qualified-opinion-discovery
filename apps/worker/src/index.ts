// Adapted from Konsensus processCrawlJob. Startup is separate, the storage
// adapter is explicit, and candidate rules/language come from the saved profile.
import { getQuestion } from "@discovery/config";
import {
  mockClassifier,
  validateClassification,
  type Classifier,
} from "@discovery/ai";
import { crawlSeedUrl, type Transport } from "@discovery/crawler";
import type { DiscoveryStore } from "@discovery/store";

export type WorkerDependencies = {
  store: DiscoveryStore;
  transport?: Transport;
  classifier?: Classifier;
};

export async function processCrawlJob(
  jobId: string,
  dependencies: WorkerDependencies,
) {
  const { store, transport, classifier = mockClassifier } = dependencies;
  const job = store.claimJob(jobId);
  if (!job) return { status: "skipped" as const };
  try {
    const question = getQuestion(job.profile, job.questionId);
    const page = await crawlSeedUrl(
      job.seedUrl,
      job.profile.crawler,
      transport,
    );
    const text = page.textExcerpt.toLocaleLowerCase(job.profile.locale);
    const selected = question.candidateTerms.some((term) =>
      text.includes(term.toLocaleLowerCase(job.profile.locale)),
    );
    const input = {
      statementText: page.textExcerpt,
      questionText: question.text,
      locale: job.profile.locale,
      choices: question.choices,
    };
    const classification = selected
      ? {
          method: classifier.id,
          promptVersion: classifier.promptVersion,
          output: validateClassification(
            input,
            await classifier.classify(input),
          ),
        }
      : undefined;
    store.finishJob(job.id, { page, classification });
    return {
      status: "finished" as const,
      outcome: selected ? "candidate" : "excluded",
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown discovery error";
    store.failJob(job.id, message);
    return { status: "failed" as const, error: message };
  }
}
