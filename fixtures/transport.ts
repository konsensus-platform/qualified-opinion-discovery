import { readFileSync } from "node:fs";
import type { HttpResponse, Transport } from "@discovery/crawler";

export function response(
  body: string,
  status = 200,
  headers: Record<string, string> = {},
): HttpResponse {
  return {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
    body: new TextEncoder().encode(body),
  };
}

export function fixtureTransport(overrides: Record<string, HttpResponse> = {}) {
  const entries: Record<string, HttpResponse> = {
    "https://opinions.example.test/robots.txt": response(
      "User-agent: *\nDisallow: /private\n",
    ),
    "https://opiniones.example.test/robots.txt": response(
      "User-agent: *\nDisallow: /private\n",
    ),
    "https://opinions.example.test/statement": response(
      readFileSync(new URL("./pages/english.html", import.meta.url), "utf8"),
    ),
    "https://opiniones.example.test/declaracion": response(
      readFileSync(new URL("./pages/spanish.html", import.meta.url), "utf8"),
    ),
    "https://opinions.example.test/unrelated": response(
      readFileSync(new URL("./pages/unrelated.html", import.meta.url), "utf8"),
    ),
    ...overrides,
  };
  const calls: string[] = [];
  const transport: Transport = async (url) => {
    calls.push(url.href);
    const result = entries[url.href];
    if (!result) throw new Error("Fixture has no response for " + url.href);
    return {
      ...result,
      headers: { ...result.headers },
      body: result.body.slice(),
    };
  };
  return { transport, calls };
}
