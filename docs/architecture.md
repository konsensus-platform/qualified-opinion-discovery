# Architecture and trust boundaries

## Scope of the extraction

This is a focused standalone backend, not a full migration of the original product. The live application configuration, production PostgreSQL schema, auth, voting, university/bar registries, cloud deployment and localized web routes are excluded.

The research stage is new here rather than extracted: upstream, candidate sources were found by a person prompting a coding agent to search the web for a given issue. This repository turns that into a stage of the pipeline — same shape, but with the search and fetch calls executed by this runtime under an instance policy, and the whole exchange written down.

The original extractor is retained with complete language-tag validation in place of truncation. The original crawler scaffold is adapted into a bounded, stateless HTTPS transport; unused browser machinery and the whole-app config dependency are removed. Classifier schemas and public prompt policy are adapted, and the mock now uses per-profile keyword rules and abstains on ambiguous matches. The previous worker's source, capture, candidate and result flow is retained in an importable handler with an explicit persistence interface. SQLite implements a new focused schema rather than pretending the full production database can be copied without its dependencies.

## The research stage

`runResearch` builds the prompt from a saved instance profile and question, then loops: the model answers, and any `search` or `fetch` tool call it makes is executed here before the result is handed back. The loop is bounded by the profile's `research` block — turns, searches, fetches — and each budget refusal is returned to the model as a tool result rather than ending the run, so the record shows what was refused.

Fetching goes through the same `crawlSeedUrl` as capture, with the profile's separate research crawler policy. A research run therefore cannot reach a host the instance has not listed, and a robots exclusion stops it exactly as it stops a capture.

Two things the model says about its own work are checked rather than believed. `fetchedByRuntime` is overwritten from this runtime's fetch log, and a quote attributed to a page this run fetched must appear verbatim in the text that page returned; a quote that does not is dropped with a reason. This is the same idea as `validateClassification`: an adapter response may not introduce material the input does not support. The unmodified model output stays in `output`, and the adjudicated list in `acceptedFindings`, so the two are never confused.

The stage ends there. It writes no crawl jobs. An operator promotes a finding with `enqueueFromFinding`, which re-checks the URL against the instance's capture policy — deliberately a different, usually narrower list than the research policy — and the resulting job is an ordinary one, subject to the same classification and the same human review.

Model and search back ends are injected. `replayResearchModel` replays a recorded script for offline demos and tests; `openAiCompatibleResearchModel` calls a configured chat-completions endpoint. A replayed run says so in its `model.provider`, so a fixture run cannot later be read as a provider call. Providers differ in what they return under "reasoning", so each entry is tagged as provider text, a provider summary, or ordinary assistant output, and the untouched provider response is kept beside this runtime's parse of it.

## Persistent state

Migration `001-initial.sql` creates profiles, jobs, sources, captures, results, public statements, classifications and review events. Migration `002-research.sql` adds research runs and their accepted findings, and lets a crawl job record the finding that proposed it. Foreign keys and transaction boundaries keep these related records together.

Profiles are keyed by instance id and revision. Reusing that identity with different content fails. Every job references a saved profile, not a mutable file on disk. Counts are scoped to the same instance and revision.

Claims change `queued` to `running` inside an immediate transaction. Two workers cannot both claim the same job. Source/capture/candidate/classification/result writes and the final job status share a transaction, so a failed write leaves no partial source. Classifier failures leave the job failed and do not create an unreviewed partial result.

The CLI drains queued jobs sequentially. It has no background scheduler. A failed job can be retried explicitly. After a crash, stop the original worker, use `recover --worker-stopped`, then `retry`. Recovery is an operator assertion; it is not a distributed lease protocol. Never recover a worker that is still running.

Review updates use an expected revision. Each successful decision appends a review event and updates the current statement status atomically. All approvals require a subject label, a qualification reference and a valid final choice. The latest rejection removes any earlier approval from the aggregate.

## Adapters and callers

- `crawlSeedUrl` accepts a `Transport` that performs exactly one HTTP request. Redirect and robots policy stays in the crawler. The live adapter validates DNS results and connects to an already checked address using the original hostname for TLS. Injected adapters are trusted code and must preserve this contract.
- `ResearchModel` and `SearchProvider` are injected the same way a `Transport` is. Neither is trusted for what it asserts about the world: the runtime performs the fetches itself and checks quotes against what it retrieved. A search back end still decides which pages the run ever sees, and no downstream check can recover what it never returned.
- `Classifier` declares an adapter id and prompt version. The worker validates each output against the exact input question, statement evidence and mandatory-review schema. This prevents a provider response from introducing an arbitrary answer, but does not make its interpretation correct.
- `DiscoveryStore` is the worker-facing interface. The SQLite adapter also supplies operator review and inspection methods.
- The CLI is for a trusted operator with access to the database. It is not an authenticated multi-user service.
- The demo and tests inject an in-memory fixture transport that throws for any unlisted URL. There is no fallback to live fetch.

## Limitations relevant to independent verification

An operator can change the database, software, fixture inputs or public template. A stored text hash authenticates nothing without an external commitment. The source text is truncated; no completeness claim follows from its hash. Classification records name a method and prompt version but do not retain an exact provider exchange. Review records are not cryptographic signatures.

A research run does retain an exact provider exchange: the prompt as sent, the responses as received, and each search and fetch this runtime performed. That closes a gap in what is *recorded*, and none of it in what is *checkable*. Those rows are written by the operator's process into the operator's database, and a reader who does not already trust the operator cannot distinguish a recorded run from a fabricated one — the transcript has no commitment outside the platform that stores it. `unverifiedCoverageClaim` is the model's own account of its coverage and is named for what it is.

An attested future runner would still require explicit trust in its hardware/cloud attestation roots, verifier policy and any external source/model service. A normal VM signing its own output would not establish which code actually ran. A remotely called LLM does not become attested inference merely because the caller runs in a trusted execution environment.

The distinction matters for the research stage specifically. An attested workload could establish what prompt left it, what response came back, and what it fetched and stored — the things it observed directly. It could not establish that the provider ran the model it named, that the model's reasoning is what a provider summary says it is, or that a search index was complete or impartial. A design that attests the first set and claims the second would be claiming more than it verified.

No approach here proves that the whole web was searched, that an excerpt's author really has a law degree, that a research run found the statements that matter, or that a classifier's interpretation is correct. The current count is an operational summary of approved statements, not the platform's voting mechanism.
