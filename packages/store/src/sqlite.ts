// Standalone adapter replacing the upstream production db barrel. Source,
// capture, candidate, classification and review semantics are retained;
// country-specific person/credential/voting tables are not imported.
import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  getQuestion,
  parseProfile,
  type InstanceProfile,
} from "@discovery/config";
import { checkedUrl } from "@discovery/crawler";
import { validateClassification } from "@discovery/ai";
import {
  reviewInputSchema,
  type DiscoveryResult,
  type DiscoveryStore,
  type Job,
  type ReviewInput,
} from "./types";

type JobRow = {
  id: string;
  question_id: string;
  seed_url: string;
  status: Job["status"];
  attempts: number;
  error: string | null;
  profile_json: string;
};
type StatementContext = {
  id: string;
  question_id: string;
  review_revision: number;
  profile_json: string;
};
export type StatementSummary = {
  id: string;
  jobId: string;
  instanceId: string;
  profileRevision: number;
  questionId: string;
  sourceUrl: string;
  title: string;
  text: string;
  languageCode: string;
  status: string;
  reviewRevision: number;
  classification: unknown;
};
export type ChoiceCount = { choiceId: string; count: number };

export class SqliteDiscoveryStore implements DiscoveryStore {
  private readonly db: Database;
  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true });
    try {
      this.db.exec(
        "PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;",
      );
      this.db
        .transaction(() => {
          const version = (
            this.db.query("PRAGMA user_version").get() as {
              user_version: number;
            }
          ).user_version;
          if (version > 1)
            throw new Error("Database schema is newer than this application");
          if (version === 0) {
            this.db.exec(
              readFileSync(
                new URL("./migrations/001-initial.sql", import.meta.url),
                "utf8",
              ),
            );
            this.db.exec("PRAGMA user_version = 1");
          }
        })
        .immediate();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  close() {
    this.db.close();
  }

  enqueue(input: InstanceProfile, seedUrl: string, questionId: string): string {
    const profile = parseProfile(input);
    getQuestion(profile, questionId);
    const url = checkedUrl(seedUrl, profile.crawler).href;
    const profileJson = JSON.stringify(profile);
    return this.db
      .transaction(() => {
        const existing = this.db
          .query(
            "SELECT profile_json FROM profiles WHERE instance_id = ? AND revision = ?",
          )
          .get(profile.id, profile.revision) as { profile_json: string } | null;
        if (existing && existing.profile_json !== profileJson) {
          throw new Error(
            "An instance revision is immutable; increment the profile revision",
          );
        }
        if (!existing)
          this.db
            .query("INSERT INTO profiles VALUES (?, ?, ?)")
            .run(profile.id, profile.revision, profileJson);
        const id = randomUUID();
        this.db
          .query(`INSERT INTO crawl_jobs
        (id, instance_id, profile_revision, question_id, seed_url, status, created_at)
        VALUES (?, ?, ?, ?, ?, 'queued', ?)`)
          .run(
            id,
            profile.id,
            profile.revision,
            questionId,
            url,
            new Date().toISOString(),
          );
        return id;
      })
      .immediate();
  }

  getJob(id: string): Job {
    const row = this.db
      .query(`SELECT j.*, p.profile_json FROM crawl_jobs j
      JOIN profiles p ON p.instance_id = j.instance_id AND p.revision = j.profile_revision WHERE j.id = ?`)
      .get(id) as JobRow | null;
    if (!row) throw new Error("Crawl job does not exist");
    return {
      id: row.id,
      questionId: row.question_id,
      seedUrl: row.seed_url,
      status: row.status,
      attempts: row.attempts,
      error: row.error,
      profile: parseProfile(JSON.parse(row.profile_json)),
    };
  }

  listJobs(): Job[] {
    const rows = this.db
      .query("SELECT id FROM crawl_jobs ORDER BY created_at, id")
      .all() as { id: string }[];
    return rows.map((row) => this.getJob(row.id));
  }

  claimJob(id: string): Job | null {
    return this.db
      .transaction(() => {
        const job = this.getJob(id);
        if (job.status !== "queued") return null;
        this.db
          .query(`UPDATE crawl_jobs SET status = 'running', attempts = attempts + 1,
        started_at = ?, finished_at = NULL, error = NULL WHERE id = ? AND status = 'queued'`)
          .run(new Date().toISOString(), id);
        return this.getJob(id);
      })
      .immediate();
  }

  retryFailedJob(id: string): void {
    const change = this.db
      .query(`UPDATE crawl_jobs SET status = 'queued', error = NULL,
      finished_at = NULL WHERE id = ? AND status = 'failed'`)
      .run(id);
    if (change.changes !== 1)
      throw new Error("Only a failed job can be retried");
  }

  recoverInterruptedJob(id: string): void {
    // Operator must first stop the worker owning this job. No automatic lease
    // stealing: an old worker may still hold a network request in flight.
    const change = this.db
      .query(`UPDATE crawl_jobs SET status = 'failed', finished_at = ?,
      error = 'Interrupted job recovered by operator' WHERE id = ? AND status = 'running'`)
      .run(new Date().toISOString(), id);
    if (change.changes !== 1)
      throw new Error("Only a running job can be recovered");
  }

  finishJob(id: string, result: DiscoveryResult): void {
    this.db
      .transaction(() => {
        const job = this.getJob(id);
        if (job.status !== "running") throw new Error("Job is not running");
        const question = getQuestion(job.profile, job.questionId);
        const page = result.page;
        if (page.requestedUrl !== job.seedUrl)
          throw new Error("Capture does not belong to this job");
        checkedUrl(page.url, job.profile.crawler);
        if (!page.textExcerpt.trim() || page.textExcerpt.length > 2400)
          throw new Error("Invalid source text");
        if (page.httpStatus !== 200)
          throw new Error("Cannot persist an unsuccessful capture");
        const sourceId = randomUUID();
        this.db
          .query("INSERT INTO sources VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
          .run(
            sourceId,
            id,
            page.requestedUrl,
            page.url,
            page.title,
            page.languageCode ?? job.profile.locale,
            page.textExcerpt,
            JSON.stringify(page.metadata),
          );
        this.db
          .query("INSERT INTO source_captures VALUES (?, ?, ?, ?, ?, ?)")
          .run(
            sourceId,
            new Date().toISOString(),
            "html_text_extraction",
            page.httpStatus,
            createHash("sha256").update(page.textExcerpt).digest("hex"),
            page.robotsStatus,
          );
        if (result.classification) {
          const classification = result.classification;
          if (
            !classification.method.trim() ||
            !classification.promptVersion.trim()
          )
            throw new Error("Missing classifier identity");
          const output = validateClassification(
            {
              statementText: page.textExcerpt,
              questionText: question.text,
              locale: job.profile.locale,
              choices: question.choices,
            },
            classification.output,
          );
          const statementId = randomUUID();
          this.db
            .query(`INSERT INTO public_statements
          (id, source_id, question_id, statement_text, language_code) VALUES (?, ?, ?, ?, ?)`)
            .run(
              statementId,
              sourceId,
              job.questionId,
              page.textExcerpt,
              page.languageCode ?? job.profile.locale,
            );
          this.db
            .query("INSERT INTO classifications VALUES (?, ?, ?, ?)")
            .run(
              statementId,
              classification.method,
              classification.promptVersion,
              JSON.stringify(output),
            );
        }
        this.db
          .query("INSERT INTO crawl_results VALUES (?, ?, ?, ?)")
          .run(
            id,
            sourceId,
            result.classification ? "candidate" : "excluded",
            result.classification
              ? "Candidate requires human review"
              : "No configured candidate term matched",
          );
        this.db
          .query(
            "UPDATE crawl_jobs SET status = 'finished', finished_at = ?, error = NULL WHERE id = ?",
          )
          .run(new Date().toISOString(), id);
      })
      .immediate();
  }

  failJob(id: string, error: string): void {
    const change = this.db
      .query(
        "UPDATE crawl_jobs SET status = 'failed', finished_at = ?, error = ? WHERE id = ? AND status = 'running'",
      )
      .run(new Date().toISOString(), error.slice(0, 2000), id);
    if (change.changes !== 1)
      throw new Error("Cannot fail a job that is not running");
  }

  listStatements(): StatementSummary[] {
    const rows = this.db
      .query(`SELECT s.id, j.id AS jobId, j.instance_id AS instanceId,
      j.profile_revision AS profileRevision, s.question_id AS questionId, o.url AS sourceUrl,
      o.title, s.statement_text AS text, s.language_code AS languageCode, s.status,
      s.review_revision AS reviewRevision, c.output_json AS classificationJson
      FROM public_statements s JOIN sources o ON o.id = s.source_id
      JOIN crawl_jobs j ON j.id = o.crawl_job_id JOIN classifications c ON c.statement_id = s.id
      ORDER BY j.created_at, s.id`)
      .all() as (Omit<StatementSummary, "classification"> & {
      classificationJson: string;
    })[];
    return rows.map(({ classificationJson, ...row }) => ({
      ...row,
      classification: JSON.parse(classificationJson),
    }));
  }

  review(input: ReviewInput): number {
    const review = reviewInputSchema.parse(input);
    return this.db
      .transaction(() => {
        const statement = this.db
          .query(`SELECT s.id, s.question_id, s.review_revision, p.profile_json
        FROM public_statements s JOIN sources o ON o.id = s.source_id
        JOIN crawl_jobs j ON j.id = o.crawl_job_id
        JOIN profiles p ON p.instance_id = j.instance_id AND p.revision = j.profile_revision WHERE s.id = ?`)
          .get(review.statementId) as StatementContext | null;
        if (!statement) throw new Error("Statement does not exist");
        if (statement.review_revision !== review.expectedRevision)
          throw new Error("Review conflict: reload the current revision");
        const profile = parseProfile(JSON.parse(statement.profile_json));
        const question = getQuestion(profile, statement.question_id);
        if (
          review.decision === "approved" &&
          !question.choices.some((c) => c.id === review.choiceId)
        ) {
          throw new Error("Final answer is not in this statement's question");
        }
        const revision = statement.review_revision + 1;
        this.db
          .query(`INSERT INTO review_events
        (id, statement_id, revision, decision, choice_id, reviewer, reason, subject_label, qualification_reference, reviewed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(
            randomUUID(),
            review.statementId,
            revision,
            review.decision,
            review.decision === "approved" ? review.choiceId : null,
            review.reviewer,
            review.reason,
            review.decision === "approved" ? review.subjectLabel : null,
            review.decision === "approved"
              ? review.qualificationReference
              : null,
            new Date().toISOString(),
          );
        this.db
          .query(
            "UPDATE public_statements SET status = ?, review_revision = ? WHERE id = ?",
          )
          .run(review.decision, revision, review.statementId);
        return revision;
      })
      .immediate();
  }

  reviewHistory(statementId: string): unknown[] {
    return this.db
      .query(
        "SELECT * FROM review_events WHERE statement_id = ? ORDER BY revision",
      )
      .all(statementId);
  }

  counts(
    instanceId: string,
    profileRevision: number,
    questionId: string,
  ): ChoiceCount[] {
    return this.db
      .query(`SELECT r.choice_id AS choiceId, COUNT(*) AS count FROM public_statements s
      JOIN review_events r ON r.statement_id = s.id AND r.revision = s.review_revision
      JOIN sources o ON o.id = s.source_id JOIN crawl_jobs j ON j.id = o.crawl_job_id
      WHERE s.status = 'approved' AND r.decision = 'approved' AND j.instance_id = ?
        AND j.profile_revision = ? AND s.question_id = ? GROUP BY r.choice_id ORDER BY r.choice_id`)
      .all(instanceId, profileRevision, questionId) as ChoiceCount[];
  }

  // Operator inspection, not a provenance proof or an independent verification.
  inspectJob(id: string) {
    const job = this.getJob(id);
    const source = this.db
      .query(`SELECT s.*, c.captured_at, c.capture_method, c.http_status, c.text_hash, c.robots_status,
      r.outcome, r.reason FROM sources s JOIN source_captures c ON c.source_id = s.id
      JOIN crawl_results r ON r.crawl_job_id = s.crawl_job_id WHERE s.crawl_job_id = ?`)
      .get(id);
    return { job, source };
  }
}
