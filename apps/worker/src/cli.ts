import { parseArgs } from "node:util";
import { loadProfile } from "@discovery/config";
import { SqliteDiscoveryStore, reviewInputSchema } from "@discovery/store";
import { processCrawlJob } from "./index";

const help = `Qualified Opinion Discovery
  bun run discovery enqueue --db PATH --profile FILE --url HTTPS_URL --question ID
  bun run discovery run --db PATH [--job UUID]
  bun run discovery jobs --db PATH
  bun run discovery inspect --db PATH --job UUID
  bun run discovery statements --db PATH
  bun run discovery review --db PATH --file REVIEW_JSON
  bun run discovery history --db PATH --statement UUID
  bun run discovery counts --db PATH --instance ID --revision N --question ID
  bun run discovery retry --db PATH --job UUID
  bun run discovery recover --db PATH --job UUID --worker-stopped

Only enqueue and run are needed to crawl configured public HTTPS sources.
Review requires an explicit local JSON decision; see examples/review.example.json.
The CLI is for a trusted local operator, not an authenticated public API.
`;

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    strict: true,
    options: {
      db: { type: "string" },
      profile: { type: "string" },
      url: { type: "string" },
      question: { type: "string" },
      job: { type: "string" },
      file: { type: "string" },
      statement: { type: "string" },
      instance: { type: "string" },
      revision: { type: "string" },
      "worker-stopped": { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  const command = positionals[0] ?? "help";
  if (command === "help" || values.help) {
    console.log(help);
    return;
  }
  const required = (name: keyof typeof values): string => {
    const value = values[name];
    if (typeof value !== "string" || !value)
      throw new Error("Missing --" + name);
    return value;
  };
  const commands = [
    "enqueue",
    "run",
    "jobs",
    "inspect",
    "statements",
    "review",
    "history",
    "counts",
    "retry",
    "recover",
  ];
  if (!commands.includes(command) || positionals.length !== 1)
    throw new Error("Unknown command; use help");
  const store = new SqliteDiscoveryStore(required("db"));
  let result: unknown;
  try {
    switch (command) {
      case "enqueue":
        result = {
          jobId: store.enqueue(
            await loadProfile(required("profile")),
            required("url"),
            required("question"),
          ),
        };
        break;
      case "run": {
        const ids = values.job
          ? [values.job]
          : store
              .listJobs()
              .filter((j) => j.status === "queued")
              .map((j) => j.id);
        const outcomes = [];
        for (const id of ids)
          outcomes.push({
            jobId: id,
            ...(await processCrawlJob(id, { store })),
          });
        if (outcomes.some((r) => r.status === "failed")) process.exitCode = 1;
        result = outcomes;
        break;
      }
      case "jobs":
        result = store.listJobs();
        break;
      case "inspect":
        result = store.inspectJob(required("job"));
        break;
      case "statements":
        result = store.listStatements();
        break;
      case "review":
        result = {
          revision: store.review(
            reviewInputSchema.parse(await Bun.file(required("file")).json()),
          ),
        };
        break;
      case "history":
        result = store.reviewHistory(required("statement"));
        break;
      case "counts": {
        const revision = Number(required("revision"));
        if (!Number.isSafeInteger(revision) || revision <= 0)
          throw new Error("Revision must be a positive integer");
        result = store.counts(
          required("instance"),
          revision,
          required("question"),
        );
        break;
      }
      case "retry":
        store.retryFailedJob(required("job"));
        result = { status: "queued" };
        break;
      case "recover":
        if (!values["worker-stopped"])
          throw new Error(
            "Stop the owning worker and pass --worker-stopped before recovery",
          );
        store.recoverInterruptedJob(required("job"));
        result = { status: "failed", next: "retry when ready" };
        break;
    }
    console.log(JSON.stringify(result, null, 2));
  } finally {
    store.close();
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(
      error instanceof Error ? error.message : "Discovery command failed",
    );
    process.exitCode = 1;
  });
}
