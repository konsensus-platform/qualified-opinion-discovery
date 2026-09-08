# Architecture and trust boundaries

## Scope of the extraction

This is a focused standalone backend, not a full migration of the original product. The live application configuration, production PostgreSQL schema, auth, voting, university/bar registries, cloud deployment and localized web routes are excluded.

The original extractor is retained with complete language-tag validation in place of truncation. The original crawler scaffold is adapted into a bounded, stateless HTTPS transport; unused browser machinery and the whole-app config dependency are removed. Classifier schemas and public prompt policy are adapted, and the mock now uses per-profile keyword rules and abstains on ambiguous matches. The previous worker's source, capture, candidate and result flow is retained in an importable handler with an explicit persistence interface. SQLite implements a new focused schema rather than pretending the full production database can be copied without its dependencies.

## Persistent state

Migration `001-initial.sql` creates profiles, jobs, sources, captures, results, public statements, classifications and review events. Foreign keys and transaction boundaries keep these related records together.

Profiles are keyed by instance id and revision. Reusing that identity with different content fails. Every job references a saved profile, not a mutable file on disk. Counts are scoped to the same instance and revision.

Claims change `queued` to `running` inside an immediate transaction. Two workers cannot both claim the same job. Source/capture/candidate/classification/result writes and the final job status share a transaction, so a failed write leaves no partial source. Classifier failures leave the job failed and do not create an unreviewed partial result.

The CLI drains queued jobs sequentially. It has no background scheduler. A failed job can be retried explicitly. After a crash, stop the original worker, use `recover --worker-stopped`, then `retry`. Recovery is an operator assertion; it is not a distributed lease protocol. Never recover a worker that is still running.

Review updates use an expected revision. Each successful decision appends a review event and updates the current statement status atomically. All approvals require a subject label, a qualification reference and a valid final choice. The latest rejection removes any earlier approval from the aggregate.

## Adapters and callers

- `crawlSeedUrl` accepts a `Transport` that performs exactly one HTTP request. Redirect and robots policy stays in the crawler. The live adapter validates DNS results and connects to an already checked address using the original hostname for TLS. Injected adapters are trusted code and must preserve this contract.
- `Classifier` declares an adapter id and prompt version. The worker validates each output against the exact input question, statement evidence and mandatory-review schema. This prevents a provider response from introducing an arbitrary answer, but does not make its interpretation correct.
- `DiscoveryStore` is the worker-facing interface. The SQLite adapter also supplies operator review and inspection methods.
- The CLI is for a trusted operator with access to the database. It is not an authenticated multi-user service.
- The demo and tests inject an in-memory fixture transport that throws for any unlisted URL. There is no fallback to live fetch.

## Limitations relevant to independent verification

An operator can change the database, software, fixture inputs or public template. A stored text hash authenticates nothing without an external commitment. The source text is truncated; no completeness claim follows from its hash. Classification records name a method and prompt version but do not retain an exact provider exchange. Review records are not cryptographic signatures.

An attested future runner would still require explicit trust in its hardware/cloud attestation roots, verifier policy and any external source/model service. A normal VM signing its own output would not establish which code actually ran. A remotely called LLM does not become attested inference merely because the caller runs in a trusted execution environment.

No approach here proves that the whole web was searched, that an excerpt's author really has a law degree, or that a classifier's interpretation is correct. The current count is an operational summary of approved statements, not the platform's voting mechanism.
