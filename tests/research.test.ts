import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProfile } from "@discovery/config";
import { SqliteDiscoveryStore } from "@discovery/store";
import {
  buildResearchPrompt,
  fixtureSearchProvider,
  replayResearchModel,
  researchPromptV1,
} from "@discovery/research";
import { processCrawlJob } from "@discovery/worker";
import { runResearchJob } from "../apps/worker/src/research";
import { fixtureTransport } from "../fixtures/transport";

const en = await loadProfile("examples/instances/open-forum-en.json");
const question = en.questions[0]!;
const statementUrl = "https://opinions.example.test/statement";
const leadUrl = "https://directory.example.test/roster/fictional-author-two";
const searchIndex = await Bun.file(
  "fixtures/research/open-forum-en.search.json",
).json();
const recordedScript = await Bun.file(
  "fixtures/research/open-forum-en.replay.json",
).json();

const cleanup: (() => void)[] = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()!();
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "discovery-research-"));
  cleanup.push(() => rmSync(dir, { recursive: true }));
  const store = new SqliteDiscoveryStore(join(dir, "store.sqlite"));
  cleanup.push(() => store.close());
  return store;
}

function run(store: SqliteDiscoveryStore, script: unknown) {
  return runResearchJob(en, question.id, {
    store,
    model: replayResearchModel(script),
    search: fixtureSearchProvider(searchIndex),
    transport: fixtureTransport().transport,
  });
}

const finding = (overrides: Record<string, unknown> = {}) => ({
  url: statementUrl,
  title: "Fictional public hearing statement",
  claimedAuthorLabel: "Fictional Author One",
  quotedStatement: "In this fictional example, a hearing should be required.",
  relevance: "States a position on the question.",
  foundVia: ["public hearing"],
  fetchedByRuntime: true,
  ...overrides,
});

const script = (turns: unknown[]) => ({
  modelName: "test-fixture",
  turns,
});
const fetchTurn = {
  reasoning: [],
  toolCalls: [{ id: "f1", name: "fetch", arguments: { url: statementUrl } }],
  output: null,
};
const answer = (findings: unknown[]) => ({
  reasoning: [],
  toolCalls: [],
  output: {
    findings,
    unverifiedCoverageClaim: "Bounded fixture run; coverage not established.",
  },
});

describe("research transcript", () => {
  test("records the exact prompt that was sent, in full", async () => {
    const store = setup();
    const outcome = await run(store, recordedScript);
    const transcript = store.getResearchRun(outcome.runId);
    const expected = buildResearchPrompt({
      profile: en,
      question,
      limits: transcript.limits,
      fetchableHosts: en.research!.crawler.allowedHosts,
    });

    expect(transcript.prompt).toEqual(expected);
    expect(transcript.promptTemplate).toEqual({
      id: researchPromptV1.id,
      version: researchPromptV1.version,
    });
    expect(transcript.prompt.user).toContain(question.text);
    // The first request carries that prompt verbatim, not a summary of it.
    expect(transcript.steps[0]!.request.system).toBe(expected.system);
    expect(transcript.steps[0]!.request.messages[0]!.content).toBe(
      expected.user,
    );
  });

  test("records every exchange, tool call and returned reasoning", async () => {
    const store = setup();
    const outcome = await run(store, recordedScript);
    const transcript = store.getResearchRun(outcome.runId);

    expect(transcript.steps).toHaveLength(3);
    expect(transcript.steps.flatMap((step) => step.toolCalls)).toHaveLength(2);
    expect(transcript.steps[0]!.toolResults[0]!.ok).toBe(true);
    expect(transcript.steps.flatMap((step) => step.reasoning).length).toBe(3);
    for (const step of transcript.steps)
      for (const entry of step.reasoning)
        expect(entry.kind).toBe("assistant_visible_text");
    // The provider response survives alongside this runtime's parse of it.
    expect(transcript.steps[2]!.rawResponse).toBeDefined();
    expect(transcript.output?.unverifiedCoverageClaim).toContain(
      "cannot say whether other public statements",
    );
  });

  test("a run that never answers fails, and is still stored in full", async () => {
    const store = setup();
    const outcome = await run(
      store,
      script(
        Array.from({ length: 6 }, () => ({
          reasoning: [],
          toolCalls: [],
          output: null,
        })),
      ),
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("no final output");
    expect(store.getResearchRun(outcome.runId).steps).toHaveLength(6);
    expect(store.listResearchRuns()[0]!.findingCount).toBe(0);
  });
});

describe("the runtime does not take the model's word for itself", () => {
  test("replaces a false claim to have fetched a page", async () => {
    const store = setup();
    // The model claims fetchedByRuntime for a host it never opened.
    const outcome = await run(
      store,
      script([answer([finding({ url: leadUrl, fetchedByRuntime: true })])]),
    );
    expect(outcome.findings[0]!.url).toBe(leadUrl);
    expect(outcome.findings[0]!.fetchedByRuntime).toBe(false);
    // The claim itself is still readable in the unmodified model output.
    expect(
      store.getResearchRun(outcome.runId).output!.findings[0]!.fetchedByRuntime,
    ).toBe(true);
  });

  test("drops a quote that is absent from the text the run retrieved", async () => {
    const store = setup();
    const outcome = await run(
      store,
      script([
        fetchTurn,
        answer([
          finding({ quotedStatement: "A hearing should never be required." }),
        ]),
      ]),
    );
    expect(outcome.accepted).toBe(0);
    expect(outcome.dropped[0]!.reason).toContain("not present in the text");
  });

  test("keeps a verbatim quote from a page the run did retrieve", async () => {
    const store = setup();
    const outcome = await run(store, script([fetchTurn, answer([finding()])]));
    expect(outcome.accepted).toBe(1);
    expect(outcome.findings[0]!.fetchedByRuntime).toBe(true);
  });

  test("drops a repeated URL rather than counting it twice", async () => {
    const store = setup();
    const outcome = await run(
      store,
      script([answer([finding(), finding({ title: "Same page again" })])]),
    );
    expect(outcome.accepted).toBe(1);
    expect(outcome.dropped[0]!.reason).toContain("Duplicate");
  });
});

describe("budgets and refusals stay in the record", () => {
  test("an exhausted fetch budget is reported to the model, not thrown", async () => {
    const store = setup();
    const outcome = await run(
      store,
      script([
        fetchTurn,
        fetchTurn,
        fetchTurn,
        fetchTurn,
        fetchTurn,
        answer([finding()]),
      ]),
    );
    const results = store
      .getResearchRun(outcome.runId)
      .steps.flatMap((step) => step.toolResults);
    expect(results.filter((result) => result.ok)).toHaveLength(4);
    expect(results.at(-1)!.error).toContain("budget");
    expect(outcome.status).toBe("finished");
  });

  test("a host outside the research policy is refused and recorded", async () => {
    const store = setup();
    const outcome = await run(
      store,
      script([
        {
          reasoning: [],
          toolCalls: [{ id: "f1", name: "fetch", arguments: { url: leadUrl } }],
          output: null,
        },
        answer([]),
      ]),
    );
    const result = store.getResearchRun(outcome.runId).steps[0]!
      .toolResults[0]!;
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not permitted by this instance");
  });
});

describe("findings reach the existing review pipeline and stop there", () => {
  test("a finding becomes an ordinary crawl job that still needs review", async () => {
    const store = setup();
    const outcome = await run(store, recordedScript);
    const promoted = outcome.findings.find((f) => f.url === statementUrl)!;
    const jobId = store.enqueueFromFinding(promoted.id);

    expect(
      (
        await processCrawlJob(jobId, {
          store,
          transport: fixtureTransport().transport,
        })
      ).status,
    ).toBe("finished");
    const statement = store.listStatements().find((s) => s.jobId === jobId)!;
    expect(statement.status).toBe("candidate");
    // Research suggested it; nothing counts until a reviewer approves.
    expect(store.counts(en.id, en.revision, question.id)).toEqual([]);
    expect(store.inspectJob(jobId).research).toMatchObject({
      findingId: promoted.id,
      researchRunId: outcome.runId,
      fetchedByRuntime: true,
    });
  });

  test("a finding this instance may not capture from is refused", async () => {
    const store = setup();
    const outcome = await run(store, recordedScript);
    const lead = outcome.findings.find((f) => f.url === leadUrl)!;
    expect(() => store.enqueueFromFinding(lead.id)).toThrow(
      "Source host is not permitted by this instance",
    );
  });

  test("the same finding cannot be queued twice", async () => {
    const store = setup();
    const outcome = await run(store, recordedScript);
    const promoted = outcome.findings.find((f) => f.url === statementUrl)!;
    store.enqueueFromFinding(promoted.id);
    expect(() => store.enqueueFromFinding(promoted.id)).toThrow(
      "already has a crawl job",
    );
  });
});

test("an existing version 1 database upgrades in place", () => {
  const dir = mkdtempSync(join(tmpdir(), "discovery-migrate-"));
  const path = join(dir, "v1.sqlite");
  try {
    const old = new Database(path, { create: true, strict: true });
    old.exec(
      readFileSync("packages/store/src/migrations/001-initial.sql", "utf8"),
    );
    old.exec("PRAGMA user_version = 1");
    old.close();

    const store = new SqliteDiscoveryStore(path);
    store.saveProfile(en);
    expect(store.listResearchRuns()).toEqual([]);
    store.close();

    const upgraded = new Database(path, { strict: true });
    expect(upgraded.query("PRAGMA user_version").get()).toEqual({
      user_version: 2,
    });
    expect(
      (
        upgraded.query("PRAGMA table_info(crawl_jobs)").all() as {
          name: string;
        }[]
      ).map((column) => column.name),
    ).toContain("research_finding_id");
    upgraded.close();
  } finally {
    rmSync(dir, { recursive: true });
  }
});
