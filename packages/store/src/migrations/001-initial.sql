-- Adapted from the source/job/statement/classification concepts in Konsensus.
-- New standalone SQLite schema; not a migration of a production database.
CREATE TABLE profiles (
  instance_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  profile_json TEXT NOT NULL CHECK (json_valid(profile_json)),
  PRIMARY KEY (instance_id, revision)
) STRICT;
CREATE TABLE crawl_jobs (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,
  profile_revision INTEGER NOT NULL,
  question_id TEXT NOT NULL,
  seed_url TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'finished', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  error TEXT,
  FOREIGN KEY (instance_id, profile_revision) REFERENCES profiles(instance_id, revision)
) STRICT;
CREATE INDEX crawl_jobs_status ON crawl_jobs(status, created_at);
CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  crawl_job_id TEXT NOT NULL UNIQUE REFERENCES crawl_jobs(id),
  requested_url TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  language_code TEXT NOT NULL,
  text_excerpt TEXT NOT NULL,
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json))
) STRICT;
CREATE TABLE source_captures (
  source_id TEXT PRIMARY KEY REFERENCES sources(id),
  captured_at TEXT NOT NULL,
  capture_method TEXT NOT NULL,
  http_status INTEGER NOT NULL,
  text_hash TEXT NOT NULL CHECK (length(text_hash) = 64),
  robots_status TEXT NOT NULL
) STRICT;
CREATE TABLE crawl_results (
  crawl_job_id TEXT PRIMARY KEY REFERENCES crawl_jobs(id),
  source_id TEXT NOT NULL REFERENCES sources(id),
  outcome TEXT NOT NULL CHECK (outcome IN ('candidate', 'excluded')),
  reason TEXT NOT NULL
) STRICT;
CREATE TABLE public_statements (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL UNIQUE REFERENCES sources(id),
  question_id TEXT NOT NULL,
  statement_text TEXT NOT NULL,
  language_code TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate', 'approved', 'rejected')),
  review_revision INTEGER NOT NULL DEFAULT 0 CHECK (review_revision >= 0)
) STRICT;
CREATE TABLE classifications (
  statement_id TEXT PRIMARY KEY REFERENCES public_statements(id),
  method TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  output_json TEXT NOT NULL CHECK (json_valid(output_json))
) STRICT;
CREATE TABLE review_events (
  id TEXT PRIMARY KEY,
  statement_id TEXT NOT NULL REFERENCES public_statements(id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
  choice_id TEXT,
  reviewer TEXT NOT NULL CHECK (length(trim(reviewer)) > 0),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  subject_label TEXT,
  qualification_reference TEXT,
  reviewed_at TEXT NOT NULL,
  UNIQUE (statement_id, revision),
  CHECK ((decision = 'approved' AND choice_id IS NOT NULL
    AND subject_label IS NOT NULL AND length(trim(subject_label)) > 0
    AND qualification_reference IS NOT NULL AND length(trim(qualification_reference)) > 0)
    OR (decision = 'rejected' AND choice_id IS NULL))
) STRICT;
