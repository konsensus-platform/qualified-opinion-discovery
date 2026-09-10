# Qualified Opinion Discovery

A country-agnostic backend for researching public statements, capturing them from their source, suggesting closed-choice answers, and recording human review. It contains a working CLI, persistent SQLite storage, an HTTPS crawler, a model-driven research stage, and an offline demo in English and Spanish.

The pipeline has four stages. **Research** asks a model to find public statements bearing on one question, executing its search and fetch calls here rather than at the provider, and stores the whole run. **Capture** crawls a chosen finding under the instance's own policy. **Classification** suggests one closed answer, using a deterministic mock in this baseline. **Review** is where a person decides; nothing counts before that.

The repository does not establish a person's qualifications, provide cryptographic provenance, or run in an attested environment. A stored research run is an operator-writable database record, not evidence — see [the current trust boundary](#current-trust-boundary). It is a standalone extraction of the discovery workflow; upstream attribution is recorded in [NOTICE.md](NOTICE.md) and [PUBLICATION-PROVENANCE.json](PUBLICATION-PROVENANCE.json).

## Run the offline demo

Install [Bun 1.3.14](https://bun.com/docs/installation), then:

```sh
bun install --frozen-lockfile
bun run check
bun run demo
```

The demo uses only checked-in synthetic HTML and a recorded model script through explicit fixtures. It runs one research stage, promotes its findings to crawl jobs, and shows a finding naming a host outside the instance's capture policy being refused rather than quietly dropped. It then exercises three jobs across two instance profiles, stores two candidate statements and one excluded source, checks that nothing counts before review, and records two fictional approvals. No external network access, API key, browser installation, or database server is needed after dependency installation.

To retain and inspect the demo database:

```sh
mkdir -p .data
bun run demo --db .data/demo.sqlite
bun run discovery jobs --db .data/demo.sqlite
bun run discovery statements --db .data/demo.sqlite
bun run discovery counts --db .data/demo.sqlite --instance open-forum-en --revision 1 --question public-hearings
bun run discovery research-runs --db .data/demo.sqlite
bun run discovery research-show --db .data/demo.sqlite --run RESEARCH_RUN_UUID
```

The demo requires a new database path to avoid modifying existing data.

## Research a question

Research is the stage that replaces reading through sources by hand. It takes one question from an instance profile, gives a model that question with its answer choices, and lets the model drive `search` and `fetch` tool calls. Both are executed **by this runtime**, not by a hosted browsing tool at the provider, so what the run recorded is what this process actually retrieved.

Offline, against the checked-in fixtures:

```sh
bun run discovery research --db .data/discovery.sqlite \
  --profile examples/instances/open-forum-en.json --question public-hearings \
  --replay fixtures/research/open-forum-en.replay.json \
  --search-index fixtures/research/open-forum-en.search.json
```

Against a live provider, supply the endpoints through the environment and drop `--replay`:

```sh
export RESEARCH_MODEL_BASE_URL=https://your-openai-compatible-endpoint/v1
export RESEARCH_MODEL_API_KEY=...
export RESEARCH_MODEL_NAME=your-model
export RESEARCH_SEARCH_ENDPOINT=https://your-search-endpoint/search
bun run discovery research --db .data/discovery.sqlite --profile /path/to/instance.json --question your-question-id
```

The search back end is any endpoint answering `{"results":[{"url","title","snippet"}]}`; no vendor is assumed and no credential lives in this repository. Each instance profile carries its own `research` block: which hosts research may fetch, and how many turns, searches and fetches one run may spend.

A run stores the exact system and user prompt, every model exchange including whatever the provider returned as reasoning and the raw response beside this runtime's parse of it, every search and fetch with its result or refusal, and the final structured output.

Two claims in that output are not taken at face value. The model's assertion that it opened a page is replaced with this runtime's own fetch record, and a quote attributed to a fetched page must appear verbatim in the text that page returned or the finding is dropped with a reason. The model's original words stay readable under `output`; the adjudicated list is `acceptedFindings`.

Research queues nothing. A finding becomes an ordinary crawl job only when an operator promotes it, and only if its host is permitted by the instance's capture policy:

```sh
bun run discovery research-findings --db .data/discovery.sqlite --run RESEARCH_RUN_UUID
bun run discovery enqueue-finding --db .data/discovery.sqlite --finding FINDING_UUID
bun run discovery run --db .data/discovery.sqlite
```

`unverifiedCoverageClaim` is the model's own description of how far it looked. It is stored because it was said. Nothing in a run establishes that the search index was complete or impartial, that the pages found are the relevant ones, or that anything was not missed.

## Configure an instance and crawl

Copy either JSON profile from [examples/instances](examples/instances). Set the name, locale, qualification label, exact permitted source hosts, question text, answer choices, candidate terms and mock keywords. The examples deliberately use reserved `.test` domains and cannot be crawled live.

For your own configured public source:

```sh
bun run discovery enqueue --db .data/discovery.sqlite --profile /path/to/instance.json --url https://your-permitted-host.example/article --question your-question-id
bun run discovery run --db .data/discovery.sqlite
bun run discovery statements --db .data/discovery.sqlite
```

The crawler visits operator-supplied seed URLs; it does not search the entire web or recursively follow links. It accepts public HTTPS on port 443, checks robots policy before each page and redirect, restricts hosts, pins a validated public DNS address per connection, and enforces response size and time limits. JavaScript rendering, compressed responses and non-HTML documents are unsupported. HTML must be UTF-8. Robots failures defer crawling; a robots file requesting a crawl delay requires a future scheduling adapter rather than being ignored.

Changing a saved instance profile requires incrementing its `revision`. Jobs retain the exact profile that was queued, so later edits cannot silently change their question or answer choices.

## Review before inclusion

Classifier suggestions never count on their own, including suggestions with `should_count: true`. To approve a statement, a local operator must identify the subject, record a qualification reference and rationale, and choose an answer belonging to that statement's saved question.

Copy [examples/review.example.json](examples/review.example.json), replace its synthetic values with your review, and use the statement's current `reviewRevision` as `expectedRevision`:

```sh
bun run discovery review --db .data/discovery.sqlite --file /path/to/review.json
bun run discovery history --db .data/discovery.sqlite --statement STATEMENT_UUID
```

A rejection uses `statementId`, `expectedRevision`, `decision: "rejected"`, `reviewer` and `reason`. Later decisions append review history and update the current decision atomically. Stale revisions are rejected. Rejecting a previously approved statement removes it from counts.

Counts mean **approved source statements per answer**, scoped to an instance, profile revision and question. They are not votes, unique-person counts, or a representative estimate of graduates' opinions. Qualification references are operator assertions that reviewers must substantiate; this backend does not independently verify degrees, authorship or identity.

## Architecture

| Workspace | Responsibility |
| --- | --- |
| `packages/config` | Validated, immutable instance profiles and question lookup |
| `packages/crawler` | Bounded HTTPS transport, robots checks and HTML text extraction |
| `packages/ai` | Closed-choice schemas, mock classification and adapter-output validation |
| `packages/research` | Research prompt, model and search adapters, bounded tool loop and run transcripts |
| `packages/store` | SQLite migration, job claims, captures, classifications and revisioned reviews |
| `apps/worker` | Importable job handler, operator CLI and synthetic demo |

`fixtures/` supplies synthetic source responses and a recorded research script. `tests/` covers the workflow, isolation, review, rollback, crawling policy, research transcripts and CLI.

The worker claims a queued job, captures one source, selects a candidate using the saved question's terms, validates a classifier suggestion, and commits the source/candidate/result together. An excluded source remains inspectable. Failures are stored and require explicit retry. Importing the worker starts no queue or network requests.

See [architecture and trust boundaries](docs/architecture.md) and [development and publication](docs/development.md).

## Containers

```sh
docker build --platform linux/amd64 -t opinion-discovery:baseline .
docker run --rm --network none --platform linux/amd64 opinion-discovery:baseline bun run check
docker run --rm --network none --platform linux/amd64 opinion-discovery:baseline bun run demo
```

Dependencies are downloaded at build time. Runtime checks and the demo work with the container network disabled. The image includes Git, Python, pip and ripgrep for development.

## Current trust boundary

The database stores extracted text (up to 2,400 characters), its ordinary SHA-256 hash, source metadata, classification suggestions and review events. These are useful operational records under the operator's control. They are not signed evidence of a complete discovery run.

A research run records the prompt that was sent, the provider's responses as received, and every search and fetch this runtime performed. That is a faithful log of one execution, and it is all it is. Every one of those rows is written by the operator's own process into the operator's own database, so a reader who does not already trust the operator has no way to tell a recorded run from an invented one. The classification stage still names a method and prompt version without retaining a provider exchange, because its baseline classifier is a deterministic mock and sends nothing.

The repository does not sign a run, expose an independent verifier, attest a cloud workload, or prove which model produced a response. Even inside an attested workload it could not: an enclave can attest what it sent to a model and what came back, not that the provider ran the model it named, that a search index was impartial, or that a fetched page was truthful. Making runs checkable without trusting this platform is unimplemented work, and the transport, model, search and storage interfaces are where it would attach.

The existing country-agnostic Konsensus frontend is a separate application. This repository currently exposes an operator CLI and TypeScript interfaces; its output is not a drop-in implementation of that frontend's public API.

## License

Source code is Apache-2.0; see [LICENSE](LICENSE). Documentation and authored synthetic data are CC BY 4.0 under [LICENSE-DATA.md](LICENSE-DATA.md). Synthetic examples contain no real person, legal case, production credential or third-party source excerpt. Installed dependencies retain their own licenses; `bun run licenses` writes a local inventory.
