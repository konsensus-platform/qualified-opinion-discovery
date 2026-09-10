// Unlike the classification template, this text is genuinely sent to the model
// on every run and recorded verbatim in the transcript. Changing it changes what
// a reader of a stored run sees under `prompt`.
import type { InstanceProfile, Question } from "@discovery/config";
import type { ResearchLimits } from "../schemas";

export const researchPromptV1 = {
  id: "public-opinion-research",
  version: "v1",
  purpose:
    "Find public statements by named professionals that bear on one closed-ended question.",
} as const;

export function buildResearchPrompt(input: {
  profile: InstanceProfile;
  question: Question;
  limits: ResearchLimits;
  fetchableHosts: readonly string[];
}): { system: string; user: string } {
  const { profile, question, limits, fetchableHosts } = input;
  const system = [
    "You research public professional opinion for an index where every entry must be traceable to its source.",
    "",
    "You are given one closed-ended question and its answer choices. Find public statements that bear on it.",
    "",
    "Rules:",
    "- Use the search and fetch tools. Do not answer from memory; a statement you cannot point at is not a finding.",
    "- Only public, published statements. No private correspondence, no paywalled text you cannot read, no social posts you did not open.",
    "- Quote the statement verbatim from the page you fetched. Do not paraphrase into the quote.",
    "- Record who appears to have made the statement, exactly as the source labels them. You are not confirming anyone's credential; a human reviewer does that afterwards.",
    "- Do not choose an answer for the question. A later classification step and a human reviewer decide that.",
    "- You may only fetch these hosts: " +
      (fetchableHosts.length
        ? fetchableHosts.join(", ")
        : "(none configured)") +
      ". Search results from other hosts may still be reported, with fetchedByRuntime false.",
    `- You have at most ${limits.maxSteps} turns, ${limits.maxSearches} searches and ${limits.maxFetches} fetches.`,
    "",
    "When you are done, reply with a single JSON object and no other text:",
    '{"findings":[{"url":"https://…","title":"…","claimedAuthorLabel":"…","quotedStatement":"…","relevance":"…","foundVia":["…"],"fetchedByRuntime":true}],"unverifiedCoverageClaim":"…"}',
    "",
    "unverifiedCoverageClaim is your own description of how far you looked and what you did not cover. It is recorded as your claim, not as evidence. Say plainly what you could not check.",
    "Return an empty findings array rather than reporting a statement you did not open.",
  ].join("\n");

  const user = [
    `Instance: ${profile.name} (${profile.id}, revision ${profile.revision})`,
    `Content language: ${profile.locale}`,
    `Qualification a reviewer will later confirm: ${profile.qualificationLabel}`,
    "",
    `Question (${question.id}): ${question.text}`,
    "",
    "Answer choices a reviewer may later select from:",
    ...question.choices.map(
      (choice) =>
        `- ${choice.slug}: ${choice.label}` +
        (choice.description ? ` — ${choice.description}` : ""),
    ),
    "",
    "Terms this instance treats as signals that a page is on topic:",
    question.candidateTerms.map((term) => `- ${term}`).join("\n"),
  ].join("\n");

  return { system, user };
}
