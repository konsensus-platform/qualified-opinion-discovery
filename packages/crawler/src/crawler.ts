// Adapted from Konsensus crawlSeedUrl. Replaces implicit Crawlee state and
// global config with a bounded one-page transport and explicit redirect policy.
import type { CrawlerPolicy } from "@discovery/config";
import { extractPage, type ExtractedPage } from "./extract";
import { canFetch } from "./robots";
import { checkedUrl, httpsTransport, type Transport } from "./transport";

export type CrawledPage = ExtractedPage & {
  requestedUrl: string;
  robotsStatus: string;
  httpStatus: number;
};

export async function crawlSeedUrl(
  seedUrl: string,
  policy: CrawlerPolicy,
  transport: Transport = httpsTransport,
): Promise<CrawledPage> {
  let url = checkedUrl(seedUrl, policy);
  const requestedUrl = url.href;
  const visited = new Set<string>();
  for (let redirects = 0; redirects <= policy.maxRedirects; redirects++) {
    if (visited.has(url.href)) throw new Error("Redirect loop");
    visited.add(url.href);
    const robots = await canFetch(url, policy, transport);
    if (!robots.allowed)
      throw new Error("Crawler refused source: " + robots.reason);
    const response = await transport(url, policy);
    if (response.body.byteLength > policy.maxResponseBytes)
      throw new Error("Source exceeds response byte limit");
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (!response.headers.location)
        throw new Error("Redirect has no location");
      url = checkedUrl(new URL(response.headers.location, url).href, policy);
      continue;
    }
    if (response.status !== 200)
      throw new Error("Source returned HTTP " + response.status);
    const contentType = response.headers["content-type"]
      ?.split(";")[0]
      ?.trim()
      .toLowerCase();
    if (contentType !== "text/html")
      throw new Error("Only HTML sources are supported");
    const page = extractPage(
      new TextDecoder("utf-8", { fatal: true }).decode(response.body),
      url.href,
    );
    if (!page.textExcerpt) throw new Error("Source has no extractable text");
    return {
      ...page,
      requestedUrl,
      robotsStatus: robots.reason,
      httpStatus: response.status,
    };
  }
  throw new Error("Source exceeded redirect limit");
}
