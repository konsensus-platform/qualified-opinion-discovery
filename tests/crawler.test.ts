import { describe, expect, test } from "bun:test";
import { loadProfile } from "@discovery/config";
import {
  checkedUrl,
  crawlSeedUrl,
  extractPage,
  isPublicAddress,
} from "@discovery/crawler";
import { fixtureTransport, response } from "../fixtures/transport";

const policy = (await loadProfile("examples/instances/open-forum-en.json"))
  .crawler;
const base = "https://opinions.example.test";

describe("source capture policy", () => {
  test("extracts text and metadata without scripts or styles", () => {
    const result = extractPage(
      '<html lang="es"><head><title>Test</title></head><body><style>bad</style><script>bad</script><p>Hola   mundo</p></body></html>',
      base,
    );
    expect(result.textExcerpt).toBe("Hola mundo");
    expect(result.title).toBe("Test");
    expect(result.languageCode).toBe("es");
    expect(
      extractPage('<html lang="zh-Hant-HK"><body>Text</body></html>', base)
        .languageCode,
    ).toBe("zh-Hant-HK");
    expect(
      extractPage('<html lang="not_a_tag"><body>Text</body></html>', base)
        .languageCode,
    ).toBeUndefined();
    expect(
      extractPage("<body>" + "x".repeat(3000) + "</body>", base).textExcerpt,
    ).toHaveLength(2400);
  });
  test("rejects unsupported schemes, credentials, ports and hosts before transport", async () => {
    for (const url of [
      "http://opinions.example.test",
      "file:///etc/passwd",
      "https://name:pass@opinions.example.test",
      "https://opinions.example.test:8443",
      "https://127.0.0.1",
      "https://opinions.example.test.evil.test",
      "https://other.example.test",
    ]) {
      const fixture = fixtureTransport();
      await expect(
        crawlSeedUrl(url, policy, fixture.transport),
      ).rejects.toThrow();
      expect(fixture.calls).toHaveLength(0);
    }
    expect(checkedUrl(base + "/statement#anchor", policy).href).toBe(
      base + "/statement",
    );
  });
  test("private, metadata, reserved and IPv4-mapped private addresses are blocked", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "0.0.0.0",
      "100.64.0.1",
      "224.0.0.1",
      "::1",
      "fe80::1",
      "fc00::1",
      "::ffff:127.0.0.1",
      "::ffff:10.1.2.3",
    ]) {
      expect(isPublicAddress(ip)).toBe(false);
    }
    expect(isPublicAddress("8.8.8.8")).toBe(true);
    expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
  });
  test("robots is checked first and blocked pages are never fetched", async () => {
    const fixture = fixtureTransport();
    await expect(
      crawlSeedUrl(base + "/private/story", policy, fixture.transport),
    ).rejects.toThrow("robots_disallow");
    expect(fixture.calls).toEqual([base + "/robots.txt"]);
  });
  test("user-agent-specific robots rules and longer Allow paths work", async () => {
    const fixture = fixtureTransport({
      [base + "/robots.txt"]: response(
        "User-agent: OtherBot\nDisallow: /\n\nUser-agent: OpinionDiscovery\nDisallow: /statement\nAllow: /statement/public\n",
      ),
      [base + "/statement/public"]: response("<body>Public content</body>"),
    });
    const page = await crawlSeedUrl(
      base + "/statement/public",
      policy,
      fixture.transport,
    );
    expect(page.textExcerpt).toBe("Public content");
  });
  test("robots failures defer the job; 404 allows fetching", async () => {
    for (const status of [301, 401, 403, 429, 500]) {
      const fixture = fixtureTransport({
        [base + "/robots.txt"]: response("", status),
      });
      await expect(
        crawlSeedUrl(base + "/statement", policy, fixture.transport),
      ).rejects.toThrow("deferred");
      expect(fixture.calls).toHaveLength(1);
    }
    const fixture = fixtureTransport({
      [base + "/robots.txt"]: response("", 404),
    });
    expect(
      (await crawlSeedUrl(base + "/statement", policy, fixture.transport))
        .robotsStatus,
    ).toBe("robots_not_found");
  });
  test("crawl-delay is not silently bypassed", async () => {
    const fixture = fixtureTransport({
      [base + "/robots.txt"]: response("User-agent: *\nCrawl-delay: 5\n"),
    });
    await expect(
      crawlSeedUrl(base + "/statement", policy, fixture.transport),
    ).rejects.toThrow("requires_scheduler");
    expect(fixture.calls).toHaveLength(1);
  });
  test("redirects get fresh robots checks and preserve requested/final URLs", async () => {
    const fixture = fixtureTransport({
      [base + "/old"]: response("", 302, { location: "/statement" }),
    });
    const page = await crawlSeedUrl(base + "/old", policy, fixture.transport);
    expect(page.requestedUrl).toBe(base + "/old");
    expect(page.url).toBe(base + "/statement");
    expect(fixture.calls).toEqual([
      base + "/robots.txt",
      base + "/old",
      base + "/robots.txt",
      base + "/statement",
    ]);
  });
  test("redirects cannot escape the allowlist or bypass robots", async () => {
    for (const destination of [
      "https://other.example.test",
      "https://169.254.169.254",
      "/private/story",
    ]) {
      const fixture = fixtureTransport({
        [base + "/old"]: response("", 302, { location: destination }),
      });
      await expect(
        crawlSeedUrl(base + "/old", policy, fixture.transport),
      ).rejects.toThrow();
      expect(fixture.calls).not.toContain(destination);
    }
  });
  test("redirect loops, response limits, errors and unsupported content fail", async () => {
    const loop = fixtureTransport({
      [base + "/old"]: response("", 302, { location: "/old" }),
    });
    await expect(
      crawlSeedUrl(base + "/old", policy, loop.transport),
    ).rejects.toThrow("loop");
    const limited = fixtureTransport({
      [base + "/large"]: response("x".repeat(1100)),
    });
    await expect(
      crawlSeedUrl(
        base + "/large",
        { ...policy, maxResponseBytes: 1024 },
        limited.transport,
      ),
    ).rejects.toThrow("limit");
    for (const reply of [
      response("", 503),
      response("binary", 200, { "content-type": "application/pdf" }),
      response("<body></body>"),
    ]) {
      const fixture = fixtureTransport({ [base + "/bad"]: reply });
      await expect(
        crawlSeedUrl(base + "/bad", policy, fixture.transport),
      ).rejects.toThrow();
    }
  });
});
