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
