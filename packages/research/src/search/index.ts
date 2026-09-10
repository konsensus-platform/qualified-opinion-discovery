import { z } from "zod";

export const searchResultSchema = z
  .object({
    url: z
      .string()
      .url()
      .refine((value) => value.startsWith("https://"), "Only HTTPS results"),
    title: z.string().trim().min(1).max(300),
    snippet: z.string().trim().max(1000),
  })
  .strict();

export type SearchResult = z.infer<typeof searchResultSchema>;

/**
 * A search back end is a third party the reader must trust for coverage: it
 * decides which pages this runtime ever sees. Nothing downstream can establish
 * that its index was complete or impartial.
 */
export interface SearchProvider {
  readonly id: string;
  search(query: string, limit: number): Promise<SearchResult[]>;
}

export const searchIndexEntrySchema = searchResultSchema
  .extend({ keywords: z.array(z.string().trim().min(1)).min(1).max(50) })
  .strict();

export type SearchIndexEntry = z.infer<typeof searchIndexEntrySchema>;

/**
 * Deterministic offline back end over a fixed index. Used by the demo and tests
 * so a full run needs no network and no search vendor account.
 */
export function fixtureSearchProvider(
  entries: unknown,
  id = "fixture-search",
): SearchProvider {
  const index = z.array(searchIndexEntrySchema).max(200).parse(entries);
  return {
    id,
    async search(query, limit) {
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      return index
        .map(({ keywords, ...result }) => ({
          result,
          score: terms.filter((term) =>
            keywords.some((keyword) => keyword.toLowerCase().includes(term)),
          ).length,
        }))
        .filter((scored) => scored.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((scored) => scored.result);
    },
  };
}
