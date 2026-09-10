import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("offline demo persists both profiles and CLI reopens its results", () => {
  const dir = mkdtempSync(join(tmpdir(), "discovery-cli-"));
  const path = join(dir, "demo.sqlite");
  try {
    const demo = Bun.spawnSync([
      process.execPath,
      "apps/worker/src/demo.ts",
      "--db",
      path,
    ]);
    expect(demo.exitCode).toBe(0);
    const result = JSON.parse(demo.stdout.toString());
    expect(result.networkRequests).toBe(0);
    expect(result.jobs).toHaveLength(3);
    expect(result.beforeReview).toEqual({ english: [], spanish: [] });
    expect(result.afterReview.english).toHaveLength(1);
    expect(result.afterReview.spanish).toHaveLength(1);
    const list = Bun.spawnSync([
      process.execPath,
      "apps/worker/src/cli.ts",
      "statements",
      "--db",
      path,
    ]);
    expect(list.exitCode).toBe(0);
    expect(JSON.parse(list.stdout.toString())).toHaveLength(2);
    const repeat = Bun.spawnSync([
      process.execPath,
      "apps/worker/src/demo.ts",
      "--db",
      path,
    ]);
    expect(repeat.exitCode).toBe(1);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("CLI runs research offline and reopens the stored transcript", () => {
  const dir = mkdtempSync(join(tmpdir(), "discovery-cli-research-"));
  const path = join(dir, "research.sqlite");
  const cli = (...args: string[]) =>
    Bun.spawnSync([process.execPath, "apps/worker/src/cli.ts", ...args]);
  try {
    const research = cli(
      "research",
      "--db",
      path,
      "--profile",
      "examples/instances/open-forum-en.json",
      "--question",
      "public-hearings",
      "--replay",
      "fixtures/research/open-forum-en.replay.json",
      "--search-index",
      "fixtures/research/open-forum-en.search.json",
    );
    expect(research.exitCode).toBe(0);
    const outcome = JSON.parse(research.stdout.toString());
    expect(outcome.status).toBe("finished");
    expect(outcome.findings).toHaveLength(2);

    const runs = cli("research-runs", "--db", path);
    expect(JSON.parse(runs.stdout.toString())[0]).toMatchObject({
      id: outcome.runId,
      modelProvider: "replay-fixture",
      promptTemplateId: "public-opinion-research",
      findingCount: 2,
    });

    // A reader with only the database can recover what was asked and answered.
    const shown = cli("research-show", "--db", path, "--run", outcome.runId);
    const transcript = JSON.parse(shown.stdout.toString());
    expect(transcript.prompt.user).toContain("public-hearings");
    expect(transcript.steps).toHaveLength(3);
    expect(transcript.output.findings).toHaveLength(2);

    const fetchable = outcome.findings.find(
      (finding: { url: string }) =>
        finding.url === "https://opinions.example.test/statement",
    );
    const queued = cli(
      "enqueue-finding",
      "--db",
      path,
      "--finding",
      fetchable.id,
    );
    expect(queued.exitCode).toBe(0);
    expect(JSON.parse(queued.stdout.toString()).jobId).toBeString();
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("CLI research explains what is missing instead of half-running", () => {
  const dir = mkdtempSync(join(tmpdir(), "discovery-cli-missing-"));
  const path = join(dir, "missing.sqlite");
  try {
    const {
      RESEARCH_MODEL_BASE_URL,
      RESEARCH_MODEL_API_KEY,
      RESEARCH_MODEL_NAME,
      RESEARCH_SEARCH_ENDPOINT,
      ...env
    } = process.env;
    const attempt = Bun.spawnSync(
      [
        process.execPath,
        "apps/worker/src/cli.ts",
        "research",
        "--db",
        path,
        "--profile",
        "examples/instances/open-forum-en.json",
        "--question",
        "public-hearings",
      ],
      { env },
    );
    expect(attempt.exitCode).toBe(1);
    expect(attempt.stderr.toString()).toContain("RESEARCH_MODEL_BASE_URL");
    // Nothing was written on the way to that failure.
    const runs = Bun.spawnSync([
      process.execPath,
      "apps/worker/src/cli.ts",
      "research-runs",
      "--db",
      path,
    ]);
    expect(JSON.parse(runs.stdout.toString())).toEqual([]);

    const unknown = Bun.spawnSync([
      process.execPath,
      "apps/worker/src/cli.ts",
      "research-show",
      "--db",
      path,
      "--run",
      crypto.randomUUID(),
    ]);
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr.toString()).toContain("Research run does not exist");
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("CLI rejects unknown commands and missing required arguments", () => {
  const invalid = Bun.spawnSync([
    process.execPath,
    "apps/worker/src/cli.ts",
    "unknown",
  ]);
  expect(invalid.exitCode).toBe(1);
  const missing = Bun.spawnSync([
    process.execPath,
    "apps/worker/src/cli.ts",
    "jobs",
  ]);
  expect(missing.exitCode).toBe(1);
  const help = Bun.spawnSync([
    process.execPath,
    "apps/worker/src/cli.ts",
    "help",
  ]);
  expect(help.exitCode).toBe(0);
  expect(help.stdout.toString()).toContain("review");
});
