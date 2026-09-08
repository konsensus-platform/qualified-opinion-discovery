import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadProfile } from "@discovery/config";
import { SqliteDiscoveryStore } from "@discovery/store";
import { classificationOutputSchema } from "@discovery/ai";
import { fixtureTransport } from "../../../fixtures/transport";
import { processCrawlJob } from "./index";

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
    const jobs = [
      store.enqueue(
        en,
        "https://opinions.example.test/statement",
        en.questions[0]!.id,
      ),
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
