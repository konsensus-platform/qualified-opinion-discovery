import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadProfile } from "@discovery/config";
import { SqliteDiscoveryStore } from "@discovery/store";
import { classificationOutputSchema } from "@discovery/ai";
import {
  fixtureSearchProvider,
  loadReplayScript,
  replayResearchModel,
} from "@discovery/research";
import { fixtureTransport } from "../../../fixtures/transport";
import { processCrawlJob } from "./index";
import { runResearchJob } from "./research";

const fixture = (path: string) =>
  new URL("../../../" + path, import.meta.url).pathname;

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { db: { type: "string" } },
    strict: true,
  });
  const directory = values.db
    ? undefined
    : mkdtempSync(join(tmpdir(), "opinion-discovery-"));
  const path = values.db ?? join(directory!, "demo.sqlite");
  if (existsSync(path)) throw new Error("Demo needs a new database path");
  const store = new SqliteDiscoveryStore(path);
  try {
    const en = await loadProfile(
      new URL("../../../examples/instances/open-forum-en.json", import.meta.url)
        .pathname,
    );
    const es = await loadProfile(
      new URL("../../../examples/instances/open-forum-es.json", import.meta.url)
        .pathname,
    );
    const { transport, calls } = fixtureTransport();

    // Stage one: research. A recorded model script drives search and fetch calls
    // that this runtime executes, and the whole exchange is stored. Nothing is
    // queued yet and nothing counts yet.
    const research = await runResearchJob(en, en.questions[0]!.id, {
      store,
      model: replayResearchModel(
        await loadReplayScript(
          fixture("fixtures/research/open-forum-en.replay.json"),
        ),
      ),
      search: fixtureSearchProvider(
        await Bun.file(
          fixture("fixtures/research/open-forum-en.search.json"),
        ).json(),
      ),
      transport,
    });
    if (research.status !== "finished")
      throw new Error("Synthetic research run failed: " + research.error);

    // Stage two: an operator turns findings into ordinary crawl jobs. A finding
    // naming a host outside this instance's capture policy is refused here, so
    // the refusal is visible rather than silent.
    const promoted: {
      url: string;
      jobId: string | null;
      refused: string | null;
    }[] = [];
    for (const finding of research.findings) {
      try {
        promoted.push({
          url: finding.url,
          jobId: store.enqueueFromFinding(finding.id),
          refused: null,
        });
      } catch (error) {
        promoted.push({
          url: finding.url,
          jobId: null,
          refused: error instanceof Error ? error.message : "Refused",
        });
      }
    }

    const jobs = [
      ...promoted.flatMap((entry) => (entry.jobId ? [entry.jobId] : [])),
      store.enqueue(
        en,
        "https://opinions.example.test/unrelated",
        en.questions[0]!.id,
      ),
      store.enqueue(
        es,
        "https://opiniones.example.test/declaracion",
        es.questions[0]!.id,
      ),
    ];
    for (const id of jobs) {
      const outcome = await processCrawlJob(id, { store, transport });
      if (outcome.status !== "finished")
        throw new Error(
          "Synthetic demo job failed: " + JSON.stringify(outcome),
        );
    }
    const beforeReview = {
      english: store.counts(en.id, en.revision, en.questions[0]!.id),
      spanish: store.counts(es.id, es.revision, es.questions[0]!.id),
    };
    for (const statement of store.listStatements()) {
      const classification = classificationOutputSchema.parse(
        statement.classification,
      );
      if (!classification.suggested_choice_id)
        throw new Error("Demo expected a suggested answer");
      store.review({
        statementId: statement.id,
        expectedRevision: 0,
        decision: "approved",
        choiceId: classification.suggested_choice_id,
        reviewer: "synthetic-demo-reviewer",
        reason:
          "Fictional review exercising the approval boundary; no real person's qualification is asserted.",
        subjectLabel: "Fictional subject for " + statement.instanceId,
        qualificationReference:
          "fixture:synthetic-law-degree/" + statement.instanceId,
      });
    }
    console.log(
      JSON.stringify(
        {
          mode: "synthetic-offline-demo",
          networkRequests: 0,
          fixtureRequests: calls.length,
          persistedDatabase: values.db ?? null,
          research: {
            runId: research.runId,
            steps: research.steps,
            accepted: research.accepted,
            dropped: research.dropped,
            promoted,
            // The stored run holds the exact prompt, every model exchange and
            // the final output. Read it with: discovery research-show --run ID
            transcriptStoredAs: "research_runs." + research.runId,
          },
          jobs: jobs.map((id) => store.inspectJob(id)),
          beforeReview,
          afterReview: {
            english: store.counts(en.id, en.revision, en.questions[0]!.id),
            spanish: store.counts(es.id, es.revision, es.questions[0]!.id),
          },
          statements: store.listStatements(),
        },
        null,
        2,
      ),
    );
  } finally {
    store.close();
    if (directory) rmSync(directory, { recursive: true });
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Demo failed");
    process.exitCode = 1;
  });
}
