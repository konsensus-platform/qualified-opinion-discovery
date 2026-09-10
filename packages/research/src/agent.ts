// One bounded research run: build the prompt, let the model drive search and
// fetch tool calls executed here, then take its final structured output. The
// loop records every exchange; it deliberately never edits `output`, and keeps
// its own adjudication of the findings alongside it.
import { randomUUID } from "node:crypto";
import {
  getQuestion,
  getResearchPolicy,
  type InstanceProfile,
} from "@discovery/config";
import type { Transport } from "@discovery/crawler";
import { buildResearchPrompt, researchPromptV1 } from "./prompts/research-v1";
import type { ResearchModel } from "./models/index";
import type { SearchProvider } from "./search/index";
import { executeResearchToolCall, researchToolNames } from "./tools";
import {
  researchTranscriptSchema,
  type ResearchFinding,
  type ResearchMessage,
  type ResearchStep,
  type ResearchTranscript,
} from "./schemas";

export type RunResearchInput = {
  profile: InstanceProfile;
  questionId: string;
  model: ResearchModel;
  search: SearchProvider;
  transport?: Transport;
  runId?: string;
  searchResultLimit?: number;
  now?: () => Date;
};

type FetchRecord = { url: string; textExcerpt: string };

export async function runResearch(
  input: RunResearchInput,
): Promise<ResearchTranscript> {
  const now = input.now ?? (() => new Date());
  const profile = input.profile;
  const question = getQuestion(profile, input.questionId);
  const policy = getResearchPolicy(profile);
  const limits = {
    maxSteps: policy.maxSteps,
    maxSearches: policy.maxSearches,
    maxFetches: policy.maxFetches,
  };
  const prompt = buildResearchPrompt({
    profile,
    question,
    limits,
    fetchableHosts: policy.crawler.allowedHosts,
  });
  const startedAt = now().toISOString();
  const messages: ResearchMessage[] = [{ role: "user", content: prompt.user }];
  const steps: ResearchStep[] = [];
  const fetched = new Map<string, FetchRecord>();
  const remaining = {
    searches: limits.maxSearches,
    fetches: limits.maxFetches,
  };
  let output: ResearchTranscript["output"] = null;
  let error: string | null = null;

  try {
    for (let index = 0; index < limits.maxSteps; index += 1) {
      const request = {
        system: prompt.system,
        messages: messages.map((message) => ({ ...message })),
        toolNames: [...researchToolNames],
      };
      const stepStartedAt = now().toISOString();
      const response = await input.model.respond(request);
      const toolResults = [];
      for (const call of response.toolCalls) {
        const result = await executeResearchToolCall(call, {
          crawler: policy.crawler,
          search: input.search,
          transport: input.transport,
          searchResultLimit: policy.searchResultLimit,
          remaining,
        });
        if (result.ok && result.name === "fetch") {
          const page = result.result as FetchRecord & { requestedUrl: string };
          fetched.set(page.url, page);
          fetched.set(page.requestedUrl, page);
        }
        toolResults.push(result);
      }
      steps.push({
        index,
        startedAt: stepStartedAt,
        finishedAt: now().toISOString(),
        request,
        reasoning: response.reasoning,
        toolCalls: response.toolCalls,
        toolResults,
        output: response.output,
        rawResponse: response.raw,
      });

      if (response.output) {
        output = response.output;
        break;
      }
      if (response.toolCalls.length) {
        messages.push({
          role: "assistant",
          content: "",
          toolCalls: response.toolCalls,
        });
        for (const result of toolResults) {
          messages.push({
            role: "tool",
            toolCallId: result.id,
            content: JSON.stringify(
              result.ok ? result.result : { error: result.error },
            ),
          });
        }
        continue;
      }
      // Neither a tool call nor a final answer. Say so once and let the
      // remaining step budget decide whether the run still completes.
      messages.push({
        role: "user",
        content:
          "That reply contained neither a tool call nor the final JSON object. Call search or fetch, or reply with the JSON object described in your instructions.",
      });
    }
    if (!output)
      error = "Model produced no final output within the step budget";
  } catch (caught) {
    error = caught instanceof Error ? caught.message : "Research run failed";
  }

  const { acceptedFindings, droppedFindings } = adjudicate(output, fetched);
  return researchTranscriptSchema.parse({
    runId: input.runId ?? randomUUID(),
    instanceId: profile.id,
    profileRevision: profile.revision,
    questionId: question.id,
    promptTemplate: {
      id: researchPromptV1.id,
      version: researchPromptV1.version,
    },
    prompt,
    model: {
      provider: input.model.provider,
      name: input.model.name,
      parameters: input.model.parameters,
    },
    limits,
    steps,
    output,
    acceptedFindings,
    droppedFindings,
    status: error ? "failed" : "finished",
    error,
    startedAt,
    finishedAt: now().toISOString(),
  } satisfies ResearchTranscript);
}

/**
 * The model reports whether it opened a page and quotes what it found. Neither
 * claim is taken on trust: `fetchedByRuntime` is replaced with this runtime's
 * own record, and a quote attributed to a fetched page must appear in the text
 * that page actually returned. A lead the runtime never opened is kept, clearly
 * marked, with its quote unchecked — the crawl stage fetches it properly later.
 */
function adjudicate(
  output: ResearchTranscript["output"],
  fetched: Map<string, FetchRecord>,
): {
  acceptedFindings: ResearchFinding[];
  droppedFindings: { url: string; reason: string }[];
} {
  const acceptedFindings: ResearchFinding[] = [];
  const droppedFindings: { url: string; reason: string }[] = [];
  const seen = new Set<string>();
  for (const finding of output?.findings ?? []) {
    if (seen.has(finding.url)) {
      droppedFindings.push({
        url: finding.url,
        reason: "Duplicate finding for the same URL",
      });
      continue;
    }
    seen.add(finding.url);
    const page = fetched.get(finding.url);
    if (page && !page.textExcerpt.includes(finding.quotedStatement)) {
      droppedFindings.push({
        url: finding.url,
        reason:
          "Quoted statement is not present in the text this run retrieved from that URL",
      });
      continue;
    }
    acceptedFindings.push({ ...finding, fetchedByRuntime: Boolean(page) });
  }
  return { acceptedFindings, droppedFindings };
}
