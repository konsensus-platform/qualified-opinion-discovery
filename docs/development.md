# Development and publication

## Normal development

Use Bun 1.3.14 and install from `bun.lock` with `bun install --frozen-lockfile`. `bun run check` typechecks, runs tests and checks the publishable tree. It does not install packages, audit remote registries, or contact GitHub. `bun run format` formats local source; `bun run format:check` verifies formatting.

The tests exercise the actual SQLite adapter and CLI, and inject source responses at the transport boundary. All source content is synthetic. Add behavior tests at those boundaries for consequential changes.

Increase the instance revision when changing any saved question, answer, locale, qualification label or crawl policy. A new database schema version requires an explicit migration path; do not edit a previously released migration to migrate existing user databases.

## Publication provenance versus release snapshots

`PUBLICATION-PROVENANCE.json` describes the upstream input and adaptation history. Its source file hashes refer to the original files, not to the evolving standalone implementation. Keep it as accurate attribution; append new upstream imports when needed.

`bun run publication:check` checks names and contents at the publication boundary and required licensing files. It intentionally does not compare every development edit against a fixed release-tree digest.

After normal checks pass, run:

```sh
bun run licenses
bun run publication:snapshot
gitleaks dir . --redact --config .gitleaks.toml
git diff --check
```

The license inventory and release manifest are generated under ignored `artifacts/`. The manifest covers file paths, byte lengths and SHA-256 hashes in the public source tree, excluding installed dependencies, Git internals and runtime data. It is a reproducibility aid, not a signature or attestation. Commit and tag a reviewed release; record the Git commit alongside the manifest. Later ordinary commits need no stale digest update.

Only the reviewed standalone tree is published. No original Git history, production datasets, cloud hardening workflow or repository-bound source digest is copied. Historical project identification remains in the attribution files.

## Reproducibility

The Dockerfile pins the Bun image by digest and dependencies by lockfile. Debian development packages are installed from the image's configured repositories at build time; this is not a claim of byte-for-byte reproducible operating-system packages. Runtime tests and demo require no network.

For an evaluation, pin the final repository's full commit hash and install all tools in the task image before either agent runs. Keep that commit reachable and the repository public. If source, prompt or environment changes after trials, regenerate both trials together.

The evaluation-specific task prompt, grading material and any proxy credentials belong outside this public source repository.
