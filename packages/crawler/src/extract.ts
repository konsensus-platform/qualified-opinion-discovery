// Adapted from Konsensus extractPage: preserve complete valid language tags
// instead of truncating them. See PUBLICATION-PROVENANCE.json and NOTICE.md.
import * as cheerio from "cheerio";

export type ExtractedPage = {
  url: string;
  title: string;
  textExcerpt: string;
  languageCode?: string;
  metadata: Record<string, unknown>;
};

export function extractPage(html: string, url: string): ExtractedPage {
  const $ = cheerio.load(html);
  $("script, style, noscript, svg").remove();
  const title =
    $("title").first().text().trim() || $("h1").first().text().trim() || url;
  let languageCode: string | undefined;
  const declaredLanguage = $("html").attr("lang")?.trim();
  if (declaredLanguage && declaredLanguage.length <= 35) {
    try {
      languageCode = Intl.getCanonicalLocales(declaredLanguage)[0];
    } catch {
      // Invalid source metadata must not override the configured fallback.
    }
  }
  const bodyText = $("body").text().replace(/\s+/g, " ").trim();

  return {
    url,
    title,
    textExcerpt: bodyText.slice(0, 2400),
    languageCode,
    metadata: {
      description: $('meta[name="description"]').attr("content") ?? null,
      ogTitle: $('meta[property="og:title"]').attr("content") ?? null,
    },
  };
}
