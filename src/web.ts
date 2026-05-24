import * as http from "http";
import * as https from "https";
import { URL } from "url";

/**
 * Free-tier web search for the agent.
 *
 * Two backends:
 *   - 'duckduckgo' (default): scrapes the lite/HTML endpoint, no key required.
 *     Always free, no quota, no signup.
 *   - 'google':              Google Custom Search JSON API. 100 queries/day
 *     free, but requires both an API key and a Custom Search Engine (CSE) id.
 *     Set ollamaCoder.googleApiKey and ollamaCoder.googleCseId in VS Code, or
 *     pass them to the helper directly.
 *
 * Returns at most `limit` results with { title, url, snippet }. Parsing
 * routines are exported so tests can verify them without network access.
 */

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchOptions {
  backend?: "duckduckgo" | "google";
  limit?: number;
  googleApiKey?: string;
  googleCseId?: string;
  signal?: AbortSignal;
}

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;

export async function searchWeb(
  query: string,
  opts: SearchOptions = {}
): Promise<SearchResult[]> {
  const q = String(query ?? "").trim();
  if (!q) return [];
  const limit = clamp(opts.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT);

  const backend = opts.backend ?? "duckduckgo";
  if (
    backend === "google" &&
    opts.googleApiKey &&
    opts.googleCseId
  ) {
    return await searchGoogle(q, limit, opts.googleApiKey, opts.googleCseId, opts.signal);
  }
  return await searchDuckDuckGo(q, limit, opts.signal);
}

async function searchDuckDuckGo(
  query: string,
  limit: number,
  signal?: AbortSignal
): Promise<SearchResult[]> {
  // DDG's lite HTML endpoint is stable across years and accepts plain GET
  // with a User-Agent. We deliberately use the "html.duckduckgo.com" host
  // (no JS required, simple markup).
  const url = new URL("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query));
  const body = await httpGetText(url, signal, {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) ollama-coder/0.1",
    "Accept": "text/html,application/xhtml+xml",
    "Accept-Language": "en-US,en;q=0.9",
  });
  return parseDuckDuckGoHtml(body, limit);
}

async function searchGoogle(
  query: string,
  limit: number,
  apiKey: string,
  cseId: string,
  signal?: AbortSignal
): Promise<SearchResult[]> {
  const url = new URL("https://customsearch.googleapis.com/customsearch/v1");
  url.searchParams.set("key", apiKey);
  url.searchParams.set("cx", cseId);
  url.searchParams.set("q", query);
  url.searchParams.set("num", String(Math.min(limit, 10)));
  const body = await httpGetText(url, signal, { Accept: "application/json" });
  return parseGoogleCseJson(body, limit);
}

/* -------------------------------------------------------------- parsers */

/**
 * Parse a DuckDuckGo lite HTML response. Exposed for unit tests.
 *
 * DDG wraps each result in:
 *   <a class="result__a" href="REDIRECT">TITLE</a>
 *   <a class="result__snippet" ...>SNIPPET</a>
 * The redirect URLs look like:
 *   //duckduckgo.com/l/?uddg=ENCODED_REAL_URL&rut=...
 * We unwrap the uddg= parameter to get the real target.
 */
export function parseDuckDuckGoHtml(
  html: string,
  limit: number = DEFAULT_LIMIT
): SearchResult[] {
  const results: SearchResult[] = [];
  // Tolerant regex: capture each result block.
  const blockRe =
    /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(html)) !== null && results.length < limit) {
    const rawHref = decodeHtml(m[1]);
    const url = unwrapDdgRedirect(rawHref);
    const title = stripTags(m[2]).trim();
    const snippet = stripTags(m[3]).trim();
    if (!url || !title) continue;
    results.push({ title, url, snippet });
  }
  return results;
}

/**
 * Parse a Google Custom Search JSON response. Exposed for unit tests.
 * https://developers.google.com/custom-search/v1/reference/rest/v1/cse/list
 */
export function parseGoogleCseJson(
  body: string,
  limit: number = DEFAULT_LIMIT
): SearchResult[] {
  let j: any;
  try {
    j = JSON.parse(body);
  } catch {
    return [];
  }
  if (j && j.error) {
    throw new Error(
      `Google CSE error ${j.error.code ?? "?"}: ${j.error.message ?? "unknown"}`
    );
  }
  const items: any[] = Array.isArray(j?.items) ? j.items : [];
  const out: SearchResult[] = [];
  for (const it of items.slice(0, limit)) {
    const title = String(it.title ?? "").trim();
    const url = String(it.link ?? "").trim();
    const snippet = String(it.snippet ?? "").trim();
    if (title && url) out.push({ title, url, snippet });
  }
  return out;
}

/* -------------------------------------------------------------- helpers */

export function unwrapDdgRedirect(href: string): string {
  // DDG wraps every link as //duckduckgo.com/l/?uddg=ENCODED&rut=...
  // Sometimes also https://duckduckgo.com/l/?uddg=...
  try {
    let s = href;
    if (s.startsWith("//")) s = "https:" + s;
    const u = new URL(s);
    if (u.hostname.endsWith("duckduckgo.com") && u.pathname.startsWith("/l/")) {
      const target = u.searchParams.get("uddg");
      if (target) return decodeURIComponent(target);
    }
    return s;
  } catch {
    return href;
  }
}

export function stripTags(html: string): string {
  return decodeHtml(html.replace(/<[^>]+>/g, ""));
}

// Compact named-entity table covering everything DDG/Google snippets are
// likely to emit. Anything else falls through unchanged.
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  mdash: "\u2014", ndash: "\u2013", hellip: "\u2026",
  lsquo: "\u2018", rsquo: "\u2019", ldquo: "\u201C", rdquo: "\u201D",
  laquo: "\u00AB", raquo: "\u00BB",
  copy: "\u00A9", reg: "\u00AE", trade: "\u2122",
  middot: "\u00B7", bull: "\u2022", deg: "\u00B0",
};

export function decodeHtml(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&([a-zA-Z]+);/g, (m, name) =>
      Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, name)
        ? NAMED_ENTITIES[name]
        : m
    );
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function httpGetText(
  url: URL,
  signal: AbortSignal | undefined,
  headers: Record<string, string>
): Promise<string> {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        method: "GET",
        headers,
      },
      (res) => {
        // Follow one level of redirects (DDG can 30x).
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          const next = new URL(res.headers.location, url);
          httpGetText(next, signal, headers).then(resolve, reject);
          res.resume();
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer | string) =>
          chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
        );
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 400) {
            reject(
              new Error(
                `web_search HTTP ${status}: ${body.slice(0, 200)}`
              )
            );
            return;
          }
          resolve(body);
        });
        res.on("error", reject);
      }
    );
    req.setTimeout(15000, () => req.destroy(new Error("web_search timed out after 15s")));
    req.on("error", reject);
    if (signal) {
      if (signal.aborted) req.destroy(new Error("aborted"));
      else signal.addEventListener("abort", () => req.destroy(new Error("aborted")));
    }
    req.end();
  });
}
