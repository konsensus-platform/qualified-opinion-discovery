// Vendor-neutral search back end: POST {query, limit} to a configured endpoint
// that answers {results:[{url,title,snippet}]}. Operators point this at whatever
// search API they hold an account with. No credentials live in this repository.
import { searchResultSchema, type SearchProvider } from "./index";

export type HttpSearchOptions = {
  endpoint?: string;
  apiKey?: string;
  timeoutMs?: number;
  fetchImplementation?: typeof fetch;
};

export function httpSearchProvider(
  options: HttpSearchOptions = {},
): SearchProvider {
  const endpoint = options.endpoint ?? process.env.RESEARCH_SEARCH_ENDPOINT;
  const apiKey = options.apiKey ?? process.env.RESEARCH_SEARCH_API_KEY;
  if (!endpoint)
    throw new Error(
      "Set RESEARCH_SEARCH_ENDPOINT, or pass a search provider explicitly",
    );
  const timeoutMs = options.timeoutMs ?? 30_000;
  const call = options.fetchImplementation ?? fetch;
  return {
    id: `http-search:${new URL(endpoint).host}`,
    async search(query, limit) {
      const response = await call(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({ query, limit }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok)
        throw new Error(`Search endpoint returned HTTP ${response.status}`);
      const body = (await response.json()) as { results?: unknown[] };
      return (body.results ?? [])
        .slice(0, limit)
        .map((result) => searchResultSchema.parse(result));
    },
  };
}
