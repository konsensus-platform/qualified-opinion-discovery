import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProfile } from "@discovery/config";
import { SqliteDiscoveryStore } from "@discovery/store";
import { classifyStatement, mockClassifier } from "@discovery/ai";
import { crawlSeedUrl } from "@discovery/crawler";
import { processCrawlJob } from "@discovery/worker";
import { fixtureTransport } from "../fixtures/transport";

const en = await loadProfile("examples/instances/open-forum-en.json");
const es = await loadProfile("examples/instances/open-forum-es.json");
const question = en.questions[0]!;
const seed = "https://opinions.example.test/statement";
const cleanup: (() => void)[] = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()!();
});
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "discovery-test-"));
  cleanup.push(() => rmSync(dir, { recursive: true }));
  const path = join(dir, "store.sqlite");
  const store = new SqliteDiscoveryStore(path);
  cleanup.push(() => store.close());
  return { store, path };
}
async function candidate(store: SqliteDiscoveryStore) {
  const id = store.enqueue(en, seed, question.id);
  expect(
    (
      await processCrawlJob(id, {
        store,
        transport: fixtureTransport().transport,
      })
    ).status,
  ).toBe("finished");
  return store.listStatements().find((s) => s.jobId === id)!;
}
function approval(statementId: string) {
  return {
    statementId,
    expectedRevision: 0,
    decision: "approved" as const,
    choiceId: question.choices[0]!.id,
    reviewer: "test-reviewer",
    reason: "Synthetic review",
    subjectLabel: "Fictional person",
    qualificationReference: "fixture:synthetic-qualification",
  };
}

describe("persisted discovery and review", () => {
  test("a candidate survives reopening but is never counted automatically", async () => {
    const { store, path } = setup();
    const statement = await candidate(store);
    expect(statement.status).toBe("candidate");
    expect(store.counts(en.id, en.revision, question.id)).toEqual([]);
    const reopened = new SqliteDiscoveryStore(path);
    try {
      expect(reopened.listStatements()[0]!.id).toBe(statement.id);
      expect(reopened.getJob(statement.jobId).status).toBe("finished");
      expect(reopened.inspectJob(statement.jobId).source).toBeTruthy();
    } finally {
      reopened.close();
    }
  });
  test("approval requires qualification evidence and a valid final choice", async () => {
    const { store } = setup();
    const statement = await candidate(store);
    expect(() =>
      store.review({ ...approval(statement.id), qualificationReference: " " }),
    ).toThrow();
    expect(() =>
      store.review({
        ...approval(statement.id),
        choiceId: es.questions[0]!.choices[0]!.id,
      }),
    ).toThrow("not in");
    expect(store.counts(en.id, en.revision, question.id)).toEqual([]);
    store.review(approval(statement.id));
    expect(store.counts(en.id, en.revision, question.id)).toEqual([
      { choiceId: question.choices[0]!.id, count: 1 },
    ]);
  });
  test("stale reviews conflict and a later rejection removes the count without erasing history", async () => {
    const { store } = setup();
    const statement = await candidate(store);
    store.review(approval(statement.id));
    expect(() => store.review(approval(statement.id))).toThrow("conflict");
    store.review({
      statementId: statement.id,
      expectedRevision: 1,
      decision: "rejected",
      reviewer: "second-reviewer",
      reason: "Attribution cannot be confirmed",
    });
    expect(store.reviewHistory(statement.id)).toHaveLength(2);
    expect(store.counts(en.id, en.revision, question.id)).toEqual([]);
    expect(store.listStatements()[0]!.status).toBe("rejected");
  });
  test("profile snapshots are immutable and jobs do not inherit later edits", () => {
    const { store } = setup();
    const profile = structuredClone(en);
    const id = store.enqueue(profile, seed, question.id);
    profile.questions[0]!.text = "Changed question";
    expect(() => store.enqueue(profile, seed, question.id)).toThrow(
      "immutable",
    );
    expect(store.getJob(id).profile.questions[0]!.text).toBe(question.text);
    profile.revision = 2;
    const newer = store.enqueue(profile, seed, question.id);
    expect(store.getJob(newer).profile.revision).toBe(2);
  });
  test("English and Spanish jobs do not mix answer sets or counts", async () => {
    const { store } = setup();
    const english = await candidate(store);
    const id = store.enqueue(
      es,
      "https://opiniones.example.test/declaracion",
      es.questions[0]!.id,
    );
    await processCrawlJob(id, {
      store,
      transport: fixtureTransport().transport,
    });
    const spanish = store.listStatements().find((s) => s.jobId === id)!;
    expect(spanish.languageCode).toBe("es");
    store.review(approval(english.id));
    expect(store.counts(es.id, es.revision, es.questions[0]!.id)).toEqual([]);
    expect(store.counts(en.id, 2, question.id)).toEqual([]);
  });
  test("non-candidate sources are stored with an exclusion and never classified", async () => {
    const { store } = setup();
    const id = store.enqueue(
      en,
      "https://opinions.example.test/unrelated",
      question.id,
    );
    let calls = 0;
    const classifier = {
      ...mockClassifier,
      classify: async () => {
        calls++;
        throw new Error("should not classify");
      },
    };
    const result = await processCrawlJob(id, {
      store,
      transport: fixtureTransport().transport,
      classifier,
    });
    expect(result).toEqual({ status: "finished", outcome: "excluded" });
    expect(calls).toBe(0);
    expect(store.listStatements()).toEqual([]);
    expect(store.inspectJob(id).source).toMatchObject({ outcome: "excluded" });
  });
  test("concurrent claimants process one job only once", async () => {
    const { store, path } = setup();
    const second = new SqliteDiscoveryStore(path);
    cleanup.push(() => second.close());
    const id = store.enqueue(en, seed, question.id);
    const fixture = fixtureTransport();
    const outcomes = await Promise.all([
      processCrawlJob(id, { store, transport: fixture.transport }),
      processCrawlJob(id, { store: second, transport: fixture.transport }),
    ]);
    expect(outcomes.map((o) => o.status).sort()).toEqual([
      "finished",
      "skipped",
    ]);
    expect(store.listStatements()).toHaveLength(1);
    expect(fixture.calls).toHaveLength(2);
    expect(store.getJob(id).attempts).toBe(1);
  });
  test("failure persists without partial candidates and can be explicitly retried", async () => {
    const { store } = setup();
    const id = store.enqueue(en, seed, question.id);
    const result = await processCrawlJob(id, {
      store,
      transport: async () => {
        throw new Error("Temporary source failure");
      },
    });
    expect(result.status).toBe("failed");
    expect(store.getJob(id).error).toBe("Temporary source failure");
    expect(store.inspectJob(id).source).toBeNull();
    store.retryFailedJob(id);
    await processCrawlJob(id, {
      store,
      transport: fixtureTransport().transport,
    });
    expect(store.getJob(id).attempts).toBe(2);
    expect(store.listStatements()).toHaveLength(1);
    expect(() => store.retryFailedJob(id)).toThrow();
  });
  test("a store validation failure rolls back source, capture and candidate inserts", async () => {
    const { store } = setup();
    const id = store.enqueue(en, seed, question.id);
    store.claimJob(id);
    const page = await crawlSeedUrl(
      seed,
      en.crawler,
      fixtureTransport().transport,
    );
    const output = await classifyStatement({
      statementText: page.textExcerpt,
      questionText: question.text,
      locale: en.locale,
      choices: question.choices,
    });
    expect(() =>
      store.finishJob(id, {
        page,
        classification: {
          method: "test",
          promptVersion: "v1",
          output: { ...output, evidence_excerpt: "Fabricated source" },
        },
      }),
    ).toThrow("excerpt");
    expect(store.inspectJob(id).source).toBeNull();
    expect(store.listStatements()).toEqual([]);
    expect(store.getJob(id).status).toBe("running");
  });
  test("a broken classifier cannot disable review or inject a different answer", async () => {
    const { store } = setup();
    const id = store.enqueue(en, seed, question.id);
    const result = await processCrawlJob(id, {
      store,
      transport: fixtureTransport().transport,
      classifier: {
        ...mockClassifier,
        classify: async (input) => ({
          ...(await classifyStatement(input)),
          choice_slug: "invented-answer",
        }),
      },
    });
    expect(result.status).toBe("failed");
    expect(store.listStatements()).toEqual([]);
  });
  test("an interrupted job requires explicit recovery and retry", () => {
    const { store } = setup();
    const id = store.enqueue(en, seed, question.id);
    store.claimJob(id);
    expect(store.claimJob(id)).toBeNull();
    store.recoverInterruptedJob(id);
    expect(store.getJob(id).status).toBe("failed");
    store.retryFailedJob(id);
    expect(store.getJob(id).status).toBe("queued");
  });
});
