-- Research runs: the stage that finds candidate sources before anything is
-- crawled, classified or reviewed. The whole transcript is kept, including the
-- exact prompt, every provider exchange and the final structured output.
-- These rows are operator-writable application records, not proofs.
CREATE TABLE research_runs (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,
  profile_revision INTEGER NOT NULL,
  question_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('finished', 'failed')),
  model_provider TEXT NOT NULL,
  model_name TEXT NOT NULL,
  prompt_template_id TEXT NOT NULL,
  prompt_template_version TEXT NOT NULL,
  prompt_system TEXT NOT NULL,
  prompt_user TEXT NOT NULL,
  transcript_json TEXT NOT NULL CHECK (json_valid(transcript_json)),
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  error TEXT,
  FOREIGN KEY (instance_id, profile_revision) REFERENCES profiles(instance_id, revision)
) STRICT;
CREATE INDEX research_runs_question ON research_runs(instance_id, profile_revision, question_id);

-- Findings this runtime accepted from a run, in the order the model reported
-- them. fetched_by_runtime records whether this run opened the page itself.
CREATE TABLE research_findings (
  id TEXT PRIMARY KEY,
  research_run_id TEXT NOT NULL REFERENCES research_runs(id),
  finding_index INTEGER NOT NULL CHECK (finding_index >= 0),
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  claimed_author_label TEXT NOT NULL,
  quoted_statement TEXT NOT NULL,
  relevance TEXT NOT NULL,
  fetched_by_runtime INTEGER NOT NULL CHECK (fetched_by_runtime IN (0, 1)),
  UNIQUE (research_run_id, finding_index),
  UNIQUE (research_run_id, url)
) STRICT;

-- A crawl job may now record which finding proposed it. NULL keeps the existing
-- behaviour: an operator enqueuing a seed URL directly.
ALTER TABLE crawl_jobs ADD COLUMN research_finding_id TEXT REFERENCES research_findings(id);
