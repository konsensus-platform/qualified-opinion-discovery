# Qualified Opinion Discovery

A country-agnostic backend for discovering public statements, suggesting closed-choice answers, and recording human review. It contains a working CLI, persistent SQLite storage, an HTTPS crawler, and an offline demo in English and Spanish.

The baseline uses a deterministic mock classifier. It does not establish a person's qualifications, provide cryptographic provenance, or run in an attested environment. It is a standalone extraction of the discovery workflow; upstream attribution is recorded in [NOTICE.md](NOTICE.md) and [PUBLICATION-PROVENANCE.json](PUBLICATION-PROVENANCE.json).

## Run the offline demo

Install [Bun 1.3.14](https://bun.com/docs/installation), then:

```sh
bun install --frozen-lockfile
bun run check
bun run demo
```

The demo uses only checked-in synthetic HTML through an explicit fixture transport. It exercises three jobs across two instance profiles, stores two candidate statements and one excluded source, checks that nothing counts before review, and records two fictional approvals. No external network access, API key, browser installation, or database server is needed after dependency installation.

To retain and inspect the demo database:

```sh
mkdir -p .data
bun run demo --db .data/demo.sqlite
bun run discovery jobs --db .data/demo.sqlite
bun run discovery statements --db .data/demo.sqlite
bun run discovery counts --db .data/demo.sqlite --instance open-forum-en --revision 1 --question public-hearings
```

The demo requires a new database path to avoid modifying existing data.

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
| `packages/store` | SQLite migration, job claims, captures, classifications and revisioned reviews |
| `apps/worker` | Importable job handler, operator CLI and synthetic demo |

`fixtures/` supplies synthetic source responses. `tests/` covers the workflow, isolation, review, rollback, crawling policy and CLI.

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

The baseline does not retain complete response bytes or exact remote model request/response transcripts, expose an independent evidence verifier, attest a cloud workload, or prove which model performed inference. The public prompt is a policy template; the mock does not send it to an LLM. A future provenance feature can build on the transport, classifier and storage interfaces without misrepresenting the current records.

The existing country-agnostic Konsensus frontend is a separate application. This repository currently exposes an operator CLI and TypeScript interfaces; its output is not a drop-in implementation of that frontend's public API.

## License

Source code is Apache-2.0; see [LICENSE](LICENSE). Documentation and authored synthetic data are CC BY 4.0 under [LICENSE-DATA.md](LICENSE-DATA.md). Synthetic examples contain no real person, legal case, production credential or third-party source excerpt. Installed dependencies retain their own licenses; `bun run licenses` writes a local inventory.
