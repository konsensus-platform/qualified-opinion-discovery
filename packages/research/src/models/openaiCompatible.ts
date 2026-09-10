// Live adapter for an OpenAI-compatible chat completions endpoint, which is the
// portable shape across the providers an operator is likely to reach. It carries
// no credentials: base URL, key and model name come from the caller or the
// environment. The provider's response is recorded verbatim in `raw`, so a later
// reader is never limited to this file's parse of it.
import {
  researchOutputSchema,
  researchToolCallSchema,
  type ResearchReasoning,
  type ResearchToolCall,
} from "../schemas";
import type {
  ResearchModel,
  ResearchModelRequest,
  ResearchModelResponse,
} from "./index";

export type OpenAiCompatibleOptions = {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  temperature?: number;
  timeoutMs?: number;
  fetchImplementation?: typeof fetch;
};

const toolSpecifications = {
  search: {
    type: "function",
    function: {
      name: "search",
      description:
        "Search the web for public statements. Returns titles, URLs and snippets.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: { query: { type: "string" } },
      },
    },
  },
  fetch: {
    type: "function",
    function: {
      name: "fetch",
      description:
        "Fetch one HTTPS page and return its extracted text. Only allowed hosts succeed.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["url"],
        properties: { url: { type: "string" } },
      },
    },
  },
} as const;

export function openAiCompatibleResearchModel(
  options: OpenAiCompatibleOptions = {},
): ResearchModel {
  const baseUrl = (
    options.baseUrl ?? process.env.RESEARCH_MODEL_BASE_URL
  )?.replace(/\/+$/, "");
  const apiKey = options.apiKey ?? process.env.RESEARCH_MODEL_API_KEY;
  const model = options.model ?? process.env.RESEARCH_MODEL_NAME;
  if (!baseUrl || !apiKey || !model) {
    throw new Error(
      "Set RESEARCH_MODEL_BASE_URL, RESEARCH_MODEL_API_KEY and RESEARCH_MODEL_NAME, or pass them explicitly",
    );
  }
  const temperature = options.temperature ?? 0;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const call = options.fetchImplementation ?? fetch;

  return {
    provider: "openai-compatible-chat-completions",
    name: model,
    parameters: { temperature, endpoint: `${baseUrl}/chat/completions` },
    async respond(
      request: ResearchModelRequest,
    ): Promise<ResearchModelResponse> {
      const body = {
        model,
        temperature,
        messages: [
          { role: "system", content: request.system },
          ...request.messages.map(toProviderMessage),
        ],
        tools: request.toolNames.map((name) => toolSpecifications[name]),
      };
      const response = await call(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      // An error response is often not JSON at all. Read the body once as text
      // so a gateway's HTML 502 reports the status rather than a parse failure.
      const bodyText = await response.text();
      let raw: unknown;
      try {
        raw = JSON.parse(bodyText);
      } catch {
        raw = { nonJsonBody: bodyText.slice(0, 2000) };
      }
      if (!response.ok) {
        throw new Error(
          `Research model returned HTTP ${response.status}: ${bodyText.slice(0, 500)}`,
        );
      }
      return { ...interpret(raw), raw };
    },
  };
}

function toProviderMessage(message: ResearchModelRequest["messages"][number]) {
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId,
      content: message.content,
    };
  }
  if (message.toolCalls?.length) {
    return {
      role: message.role,
      content: message.content,
      tool_calls: message.toolCalls.map((toolCall) => ({
        id: toolCall.id,
        type: "function",
        function: {
          name: toolCall.name,
          arguments: JSON.stringify(toolCall.arguments),
        },
      })),
    };
  }
  return { role: message.role, content: message.content };
}

function interpret(raw: unknown): Omit<ResearchModelResponse, "raw"> {
  const message = (
    raw as {
      choices?: { message?: Record<string, unknown> }[];
    }
  ).choices?.[0]?.message;
  if (!message) throw new Error("Research model returned no message");

  const reasoning: ResearchReasoning[] = [];
  // Providers differ: some return a redacted summary, some a fuller text, some
  // nothing at all. Whatever arrives is labelled for what it is rather than
  // being flattened into one word.
  if (
    typeof message.reasoning_content === "string" &&
    message.reasoning_content.trim()
  ) {
    reasoning.push({
      kind: "provider_reasoning_text",
      text: message.reasoning_content,
    });
  }
  if (typeof message.reasoning === "string" && message.reasoning.trim()) {
    reasoning.push({
      kind: "provider_reasoning_summary",
      text: message.reasoning,
    });
  }
  const toolCalls: ResearchToolCall[] = [];
  for (const entry of (message.tool_calls as unknown[] | undefined) ?? []) {
    const call = entry as {
      id?: string;
      function?: { name?: string; arguments?: string };
    };
    toolCalls.push(
      researchToolCallSchema.parse({
        id: call.id,
        name: call.function?.name,
        arguments: JSON.parse(call.function?.arguments ?? "{}"),
      }),
    );
  }

  const content = typeof message.content === "string" ? message.content : "";
  const output = toolCalls.length ? null : parseOutput(content);
  // Visible text is reasoning only when it is not itself the final answer.
  // Recording the answer twice would put the structured output into the
  // reasoning trace, where a reader would mistake it for the model's thinking.
  if (content.trim() && !output)
    reasoning.push({ kind: "assistant_visible_text", text: content });

  return { reasoning, toolCalls, output };
}

function parseOutput(content: string) {
  const trimmed = content.trim();
  if (!trimmed) return null;
  // Models commonly wrap JSON in a fenced block; accept that without accepting
  // arbitrary prose around an object.
  const fenced = /^```(?:json)?\s*([\s\S]+?)\s*```$/.exec(trimmed);
  const candidate = fenced?.[1] ?? trimmed;
  if (!candidate.startsWith("{")) return null;
  try {
    return researchOutputSchema.parse(JSON.parse(candidate));
  } catch {
    return null;
  }
}
