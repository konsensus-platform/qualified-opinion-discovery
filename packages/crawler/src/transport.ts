import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import type { CrawlerPolicy } from "@discovery/config";

export type HttpResponse = {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
};
// A transport performs ONE request: redirects are handled by the policy layer.
export type Transport = (
  url: URL,
  policy: CrawlerPolicy,
) => Promise<HttpResponse>;

export function checkedUrl(value: string, policy: CrawlerPolicy): URL {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443")
  ) {
    throw new Error("Only credential-free HTTPS on port 443 is supported");
  }
  if (
    isIP(url.hostname.replace(/^\[|\]$/g, "")) ||
    !policy.allowedHosts.includes(url.hostname)
  ) {
    throw new Error("Source host is not permitted by this instance");
  }
  url.hash = "";
  return url;
}

export function isPublicAddress(address: string): boolean {
  try {
    // process() maps IPv4-mapped IPv6 addresses before checking private ranges.
    return ipaddr.process(address).range() === "unicast";
  } catch {
    return false;
  }
}

export const httpsTransport: Transport = async (url, policy) => {
  checkedUrl(url.href, policy);
  const deadline = Date.now() + policy.timeoutMs;
  let dnsTimer: ReturnType<typeof setTimeout> | undefined;
  const addresses = await Promise.race([
    lookup(url.hostname, { all: true }),
    new Promise<never>((_, reject) => {
      dnsTimer = setTimeout(
        () => reject(new Error("DNS lookup timed out")),
        policy.timeoutMs,
      );
    }),
  ]).finally(() => clearTimeout(dnsTimer));
  if (
    !addresses.length ||
    addresses.some(({ address }) => !isPublicAddress(address))
  ) {
    throw new Error("Source host resolved to a non-public address");
  }
  const target = addresses[0]!;
  return new Promise<HttpResponse>((resolve, reject) => {
    // Pin the already-validated address: do not resolve again at connection time.
    // Original hostname remains the TLS server name and Host header.
    const req = request(url, {
      agent: false,
      headers: {
        "user-agent": policy.userAgent,
        accept: "text/html,text/plain",
        "accept-encoding": "identity",
      },
      lookup: (_hostname, options, callback) => {
        if (options.all) callback(null, [target]);
        else callback(null, target.address, target.family);
      },
    });
    const timer = setTimeout(
      () => req.destroy(new Error("Source request timed out")),
      Math.max(1, deadline - Date.now()),
    );
    req.on("error", reject);
    req.on("close", () => clearTimeout(timer));
    req.on("response", (res) => {
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(res.headers)) {
        if (value !== undefined)
          headers[name] = Array.isArray(value) ? value.join(", ") : value;
      }
      if (
        headers["content-encoding"] &&
        headers["content-encoding"] !== "identity"
      ) {
        res.destroy(new Error("Compressed responses are not supported"));
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > policy.maxResponseBytes) {
          res.destroy(new Error("Source exceeds response byte limit"));
          return;
        }
        chunks.push(chunk);
      });
      res.on("error", reject);
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          headers,
          body: Buffer.concat(chunks),
        }),
      );
    });
    req.end();
  });
};
