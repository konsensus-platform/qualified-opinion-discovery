// The research stage that runs before any crawl: one question in, candidate
// sources out. It stores the whole transcript and queues nothing on its own —
// an operator decides which findings become crawl jobs, and human review still
// stands between a finding and an approved statement.
import type { InstanceProfile } from "@discovery/config";
import type { Transport } from "@discovery/crawler";
import {
  runResearch,
  type ResearchModel,
  type SearchProvider,
} from "@discovery/research";
import type { SqliteDiscoveryStore } from "@discovery/store";

export type ResearchDependencies = {
  store: SqliteDiscoveryStore;
  model: ResearchModel;
  search: SearchProvider;
  transport?: Transport;
};

export async function runResearchJob(
  profile: InstanceProfile,
  questionId: string,
  dependencies: ResearchDependencies,
) {
  const { store, model, search, transport } = dependencies;
  store.saveProfile(profile);
  const transcript = await runResearch({
    profile,
    questionId,
    model,
    search,
    transport,
  });
  store.saveResearchRun(transcript);
  return {
    runId: transcript.runId,
    status: transcript.status,
    error: transcript.error,
    steps: transcript.steps.length,
    accepted: transcript.acceptedFindings.length,
    dropped: transcript.droppedFindings,
    findings: store.listResearchFindings(transcript.runId),
  };
}
