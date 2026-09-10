// The live model and search adapters, exercised through their injected fetch
// seam. These are the paths a real run takes; the replay fixtures never reach
// them, so nothing here relies on a provider account or the network.
import { describe, expect, test } from "bun:test";
import {
  httpSearchProvider,
  openAiCompatibleResearchModel,
} from "@discovery/research";

type Captured = { url: string; init: RequestInit };

function stubFetch(
  reply: { status?: number; body: unknown; text?: string },
  captured: Captured[] = [],
) {
  const call = (async (url: string | URL, init: RequestInit = {}) => {
    captured.push({ url: String(url), init });
    const status = reply.status ?? 200;
    const text = reply.text ?? JSON.stringify(reply.body);
    return new Response(text, {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { call, captured };
}

const options = {
  baseUrl: "https://model.example.test/v1/",
  apiKey: "test-key",
  model: "test-model",
};
const request = {
  system: "system prompt",
  messages: [{ role: "user" as const, content: "user prompt" }],
  toolNames: ["search" as const, "fetch" as const],
};
const assistant = (message: Record<string, unknown>) => ({
  choices: [{ message }],
});
const validOutput = {
  findings: [],
  unverifiedCoverageClaim: "Nothing was searched in this unit test.",
};

function model(reply: Parameters<typeof stubFetch>[0], captured?: Captured[]) {
  const stub = stubFetch(reply, captured);
  return openAiCompatibleResearchModel({
    ...options,
    fetchImplementation: stub.call,
  });
}

describe("openAiCompatibleResearchModel configuration", () => {
  test("refuses to build without an endpoint, key and model name", () => {
    expect(() =>
      openAiCompatibleResearchModel({ baseUrl: "https://x.test", apiKey: "k" }),
    ).toThrow("RESEARCH_MODEL_BASE_URL");
  });

  test("reports the endpoint and model it will actually call", () => {
    const adapter = model({ body: assistant({ content: "hi" }) });
    expect(adapter.provider).toBe("openai-compatible-chat-completions");
    expect(adapter.name).toBe("test-model");
    // The trailing slash in baseUrl must not produce a doubled path.
    expect(adapter.parameters.endpoint).toBe(
      "https://model.example.test/v1/chat/completions",
    );
  });
});

describe("openAiCompatibleResearchModel request", () => {
  test("sends the system prompt, the conversation and both tool schemas", async () => {
    const captured: Captured[] = [];
    await model({ body: assistant({ content: "hi" }) }, captured).respond(
      request,
    );
    const [sent] = captured;
    expect(sent!.url).toBe("https://model.example.test/v1/chat/completions");
    expect((sent!.init.headers as Record<string, string>).authorization).toBe(
      "Bearer test-key",
    );
    const body = JSON.parse(String(sent!.init.body));
    expect(body.model).toBe("test-model");
    expect(body.temperature).toBe(0);
    expect(body.messages[0]).toEqual({
      role: "system",
      content: "system prompt",
    });
    expect(body.messages[1]).toEqual({ role: "user", content: "user prompt" });
    expect(
      body.tools.map((t: { function: { name: string } }) => t.function.name),
    ).toEqual(["search", "fetch"]);
  });

  test("round-trips an assistant tool call and its tool result", async () => {
    const captured: Captured[] = [];
    await model({ body: assistant({ content: "hi" }) }, captured).respond({
      ...request,
      messages: [
        { role: "user", content: "user prompt" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "c1", name: "search", arguments: { query: "hearings" } },
          ],
        },
        { role: "tool", toolCallId: "c1", content: '{"results":[]}' },
      ],
    });
    const body = JSON.parse(String(captured[0]!.init.body));
    expect(body.messages[2].tool_calls).toEqual([
      {
        id: "c1",
        type: "function",
        function: { name: "search", arguments: '{"query":"hearings"}' },
      },
    ]);
    expect(body.messages[3]).toEqual({
      role: "tool",
      tool_call_id: "c1",
      content: '{"results":[]}',
    });
  });
});

describe("openAiCompatibleResearchModel response", () => {
  test("labels each kind of reasoning a provider may return", async () => {
    const response = await model({
      body: assistant({
        reasoning_content: "full trace",
        reasoning: "short summary",
        content: "some prose",
      }),
    }).respond(request);
    expect(response.reasoning).toEqual([
      { kind: "provider_reasoning_text", text: "full trace" },
      { kind: "provider_reasoning_summary", text: "short summary" },
      { kind: "assistant_visible_text", text: "some prose" },
    ]);
  });

  test("ignores blank and non-string reasoning fields", async () => {
    const response = await model({
      body: assistant({ reasoning_content: "   ", reasoning: 42, content: "" }),
    }).respond(request);
    expect(response.reasoning).toEqual([]);
  });

  test("keeps the provider body verbatim beside the parse of it", async () => {
    const body = assistant({ content: "hello", provider_specific: { a: 1 } });
    const response = await model({ body }).respond(request);
    expect(response.raw).toEqual(body);
  });

  test("parses tool calls, and reports no output while tools are pending", async () => {
    const response = await model({
      body: assistant({
        content: "let me look",
        tool_calls: [
          {
            id: "c1",
            function: { name: "search", arguments: '{"query":"hearings"}' },
          },
          {
            id: "c2",
            function: {
              name: "fetch",
              arguments: '{"url":"https://opinions.example.test/statement"}',
            },
          },
        ],
      }),
    }).respond(request);
    expect(response.toolCalls).toEqual([
      { id: "c1", name: "search", arguments: { query: "hearings" } },
      {
        id: "c2",
        name: "fetch",
        arguments: { url: "https://opinions.example.test/statement" },
      },
    ]);
    expect(response.output).toBeNull();
  });

  test("rejects a tool call the schema does not allow", async () => {
    const adapter = model({
      body: assistant({
        tool_calls: [
          {
            id: "c1",
            function: {
              name: "fetch",
              arguments: '{"url":"http://insecure.test"}',
            },
          },
        ],
      }),
    });
    expect(adapter.respond(request)).rejects.toThrow();
  });

  test("accepts a bare and a fenced final answer", async () => {
    const bare = await model({
      body: assistant({ content: JSON.stringify(validOutput) }),
    }).respond(request);
    expect(bare.output).toEqual(validOutput);

    const fenced = await model({
      body: assistant({
        content: "```json\n" + JSON.stringify(validOutput) + "\n```",
      }),
    }).respond(request);
    expect(fenced.output).toEqual(validOutput);
  });

  test("does not repeat the final answer inside the reasoning trace", async () => {
    const response = await model({
      body: assistant({ content: JSON.stringify(validOutput) }),
    }).respond(request);
    expect(response.output).toEqual(validOutput);
    expect(response.reasoning).toEqual([]);
  });

  test("treats prose and malformed or non-conforming JSON as no answer yet", async () => {
    for (const content of [
      "I will keep looking.",
      "{ not json ",
      JSON.stringify({ findings: [], unexpectedKey: true }),
    ]) {
      const response = await model({ body: assistant({ content }) }).respond(
        request,
      );
      expect(response.output).toBeNull();
      // The text survives as reasoning, so the run stays inspectable.
      expect(response.reasoning).toEqual([
        { kind: "assistant_visible_text", text: content },
      ]);
    }
  });

  test("reports an HTTP failure by status even when the body is not JSON", async () => {
    const adapter = model({
      status: 502,
      body: null,
      text: "<html>Bad Gateway</html>",
    });
    expect(adapter.respond(request)).rejects.toThrow(
      "Research model returned HTTP 502",
    );
  });

  test("rejects a success response that carries no message", async () => {
    expect(model({ body: { choices: [] } }).respond(request)).rejects.toThrow(
      "no message",
    );
  });
});

describe("httpSearchProvider", () => {
  const endpoint = "https://search.example.test/search";
  const result = {
    url: "https://opinions.example.test/statement",
    title: "Statement",
    snippet: "A snippet.",
  };

  test("refuses to build without an endpoint", () => {
    const saved = process.env.RESEARCH_SEARCH_ENDPOINT;
    delete process.env.RESEARCH_SEARCH_ENDPOINT;
    try {
      expect(() => httpSearchProvider()).toThrow("RESEARCH_SEARCH_ENDPOINT");
    } finally {
      if (saved !== undefined) process.env.RESEARCH_SEARCH_ENDPOINT = saved;
    }
  });

  test("posts the query and names the host it will ask", async () => {
    const captured: Captured[] = [];
    const stub = stubFetch({ body: { results: [result] } }, captured);
    const provider = httpSearchProvider({
      endpoint,
      apiKey: "search-key",
      fetchImplementation: stub.call,
    });
    expect(provider.id).toBe("http-search:search.example.test");
    expect(await provider.search("hearings", 5)).toEqual([result]);
    expect(JSON.parse(String(captured[0]!.init.body))).toEqual({
      query: "hearings",
      limit: 5,
    });
    expect(
      (captured[0]!.init.headers as Record<string, string>).authorization,
    ).toBe("Bearer search-key");
  });

  test("omits the authorization header when no key is configured", async () => {
    const captured: Captured[] = [];
    const stub = stubFetch({ body: { results: [] } }, captured);
    const saved = process.env.RESEARCH_SEARCH_API_KEY;
    delete process.env.RESEARCH_SEARCH_API_KEY;
    try {
      await httpSearchProvider({
        endpoint,
        fetchImplementation: stub.call,
      }).search("hearings", 5);
      expect(
        (captured[0]!.init.headers as Record<string, string>).authorization,
      ).toBeUndefined();
    } finally {
      if (saved !== undefined) process.env.RESEARCH_SEARCH_API_KEY = saved;
    }
  });

  test("honours the caller's limit even when the endpoint overruns it", async () => {
    const stub = stubFetch({
      body: { results: [result, { ...result, url: result.url + "/2" }] },
    });
    const results = await httpSearchProvider({
      endpoint,
      fetchImplementation: stub.call,
    }).search("hearings", 1);
    expect(results).toHaveLength(1);
  });

  test("treats a missing results array as no results", async () => {
    const stub = stubFetch({ body: {} });
    expect(
      await httpSearchProvider({
        endpoint,
        fetchImplementation: stub.call,
      }).search("hearings", 5),
    ).toEqual([]);
  });

  test("rejects a result the schema does not allow", async () => {
    const stub = stubFetch({
      body: { results: [{ ...result, url: "http://insecure.test" }] },
    });
    expect(
      httpSearchProvider({
        endpoint,
        fetchImplementation: stub.call,
      }).search("hearings", 5),
    ).rejects.toThrow();
  });

  test("reports a failing search endpoint by status", async () => {
    const stub = stubFetch({ status: 500, body: { error: "nope" } });
    expect(
      httpSearchProvider({
        endpoint,
        fetchImplementation: stub.call,
      }).search("hearings", 5),
    ).rejects.toThrow("HTTP 500");
  });
});
