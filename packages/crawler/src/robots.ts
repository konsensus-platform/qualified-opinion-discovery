// Replaces the upstream global-configuration/fail-open robots scaffold with
// explicit per-instance policy and a user-agent-aware parser.
import robotsParser from "robots-parser";
import type { CrawlerPolicy } from "@discovery/config";
import { checkedUrl, type Transport } from "./transport";

export async function canFetch(
  url: URL,
  policy: CrawlerPolicy,
  transport: Transport,
) {
  const robotsUrl = checkedUrl(new URL("/robots.txt", url).href, policy);
  const response = await transport(robotsUrl, {
    ...policy,
    maxResponseBytes: Math.min(policy.maxResponseBytes, 512_000),
  });
  if (response.body.byteLength > Math.min(policy.maxResponseBytes, 512_000)) {
    throw new Error("Robots response exceeds byte limit");
  }
  if (response.status === 404 || response.status === 410) {
    return { allowed: true, reason: "robots_not_found" };
  }
  if (response.status !== 200) {
    throw new Error("Robots policy unavailable; crawling is deferred");
  }
  const robots = robotsParser(
    robotsUrl.href,
    new TextDecoder().decode(response.body),
  );
  // Conservative: sites asking for a crawl delay require a scheduling adapter.
  // No unimplemented delay is silently ignored.
  if ((robots.getCrawlDelay(policy.userAgent) ?? 0) > 0) {
    return { allowed: false, reason: "robots_crawl_delay_requires_scheduler" };
  }
  const allowed = robots.isAllowed(url.href, policy.userAgent) === true;
  return { allowed, reason: allowed ? "robots_allowed" : "robots_disallow" };
}
