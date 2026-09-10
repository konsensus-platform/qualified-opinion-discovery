// Tool execution happens in this runtime, not at the model provider. A hosted
// browsing tool would leave only the provider's account of what it read; here
// the fetch is performed here, under this instance's crawler policy, and the
// result is recorded before it is handed back to the model.
import type { CrawlerPolicy } from "@discovery/config";
import { crawlSeedUrl, type Transport } from "@discovery/crawler";
import type { SearchProvider } from "./search/index";
import type { ResearchToolCall, ResearchToolResult } from "./schemas";

export const researchToolNames = ["search", "fetch"] as const;

export type ToolContext = {
  crawler: CrawlerPolicy;
  search: SearchProvider;
  transport?: Transport;
  searchResultLimit: number;
  remaining: { searches: number; fetches: number };
};

export async function executeResearchToolCall(
  call: ResearchToolCall,
  context: ToolContext,
): Promise<ResearchToolResult> {
  try {
    if (call.name === "search") {
      if (context.remaining.searches <= 0)
        throw new Error("Search budget for this run is exhausted");
      context.remaining.searches -= 1;
      const results = await context.search.search(
        call.arguments.query,
        context.searchResultLimit,
      );
      return {
        id: call.id,
        name: "search",
        ok: true,
        result: { provider: context.search.id, results },
        error: null,
      };
    }
    if (context.remaining.fetches <= 0)
      throw new Error("Fetch budget for this run is exhausted");
    context.remaining.fetches -= 1;
    const page = await crawlSeedUrl(
      call.arguments.url,
      context.crawler,
      context.transport,
    );
    return {
      id: call.id,
      name: "fetch",
      ok: true,
      result: {
        requestedUrl: page.requestedUrl,
        url: page.url,
        title: page.title,
        languageCode: page.languageCode ?? null,
        httpStatus: page.httpStatus,
        robotsStatus: page.robotsStatus,
        textExcerpt: page.textExcerpt,
      },
      error: null,
    };
  } catch (error) {
    // A refused host, a robots exclusion or an exhausted budget is reported back
    // to the model rather than ending the run, and is kept in the transcript.
    return {
      id: call.id,
      name: call.name,
      ok: false,
      result: null,
      error: (error instanceof Error
        ? error.message
        : "Tool call failed"
      ).slice(0, 2000),
    };
  }
}
