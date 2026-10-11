// HTTP access for the audit toolkit: page fetches and link checks with timeouts and a
// short-lived cache. Never throws for HTTP or network errors.
import { resolveHttpUrl, stripQueries } from "@/lib/audit/url";

export interface FetchedPage {
  url: string;
  finalUrl: string;
  /** null when the request never got a response (DNS, connection, timeout). */
  status: number | null;
  /** Response headers with lower-cased names. */
  headers: Record<string, string>;
  /** Body text for HTML/XML/text responses, "" otherwise. */
  html: string;
  bytes: number;
  error?: string;
}

export interface UrlCheck {
  url: string;
  status: number | null;
  ok: boolean;
  error?: string;
  bytes?: number | null;
}

const PAGE_TIMEOUT_MS = 6_000;
const LINK_TIMEOUT_MS = 4_000;
const CACHE_TTL_MS = 60_000;
const CACHE_PRUNE_AT = 1_000;
/** Page bodies above this are truncated (the analyzers only need the markup). */
const MAX_PAGE_BYTES = 5 * 1024 * 1024;
/** Stop counting a body without content-length after this many bytes. */
const MAX_COUNT_BYTES = 50 * 1024 * 1024;
const USER_AGENT = "AxolotlAudit/0.1 (site audit bot)";

interface CacheEntry<T> {
  at: number;
  value: Promise<T>;
}

const pageCache = new Map<string, CacheEntry<FetchedPage>>();
const checkCache = new Map<string, CacheEntry<UrlCheck>>();

export function clearFetchCache(): void {
  pageCache.clear();
  checkCache.clear();
}

/** GET a page (redirects followed). Cached for ~60s; concurrent calls share one request. */
export function fetchPage(url: string): Promise<FetchedPage> {
  const key = cacheKey(url);
  return cached(pageCache, key, () => loadPage(key));
}

/** Is the URL reachable? HEAD first, GET when HEAD answers an error status or fails at the network level. */
export function checkUrl(url: string): Promise<UrlCheck> {
  const key = cacheKey(url);
  return cached(checkCache, key, () => loadCheck(key));
}

/** True when the response is an HTML document. */
export function isHtmlResponse(page: FetchedPage): boolean {
  const type = page.headers["content-type"] ?? "";
  return type === "" ? /<html[\s>]/i.test(page.html) : /text\/html|application\/xhtml\+xml/i.test(type);
}

/** Runs `fn` over `items` with at most `limit` in flight; results keep input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  // `|| 1` keeps a NaN limit from starting zero workers (which would return unfilled results).
  const workers = Math.min(Math.max(1, Math.floor(limit) || 1), items.length);
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}

// ---------- internals ----------

function cacheKey(url: string): string {
  const hashAt = url.indexOf("#");
  return (hashAt >= 0 ? url.slice(0, hashAt) : url).trim();
}

function cached<T>(cache: Map<string, CacheEntry<T>>, key: string, load: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.value;
  if (cache.size >= CACHE_PRUNE_AT) pruneExpired(cache, now);
  const value = load();
  cache.set(key, { at: now, value });
  value.catch(() => cache.delete(key));
  return value;
}

function pruneExpired<T>(cache: Map<string, CacheEntry<T>>, now: number): void {
  for (const [key, entry] of cache) {
    if (now - entry.at >= CACHE_TTL_MS) cache.delete(key);
  }
}

async function loadPage(url: string): Promise<FetchedPage> {
  const failed = (error: string): FetchedPage => ({ url, finalUrl: url, status: null, headers: {}, html: "", bytes: 0, error });
  if (!resolveHttpUrl(url)) return failed("not an http(s) URL");
  return withTimeout(PAGE_TIMEOUT_MS, async (signal, timedOut) => {
    try {
      const res = await fetch(url, requestInit("GET", signal, "text/html,application/xhtml+xml,*/*;q=0.8"));
      const headers = headersToRecord(res.headers);
      const declared = parseLength(headers["content-length"]);
      let html = "";
      let bytes = declared ?? 0;
      if (isTextual(headers["content-type"] ?? "")) {
        const body = await readBody(res, MAX_PAGE_BYTES, MAX_PAGE_BYTES);
        html = body.data.toString("utf8");
        bytes = declared ?? body.total;
      } else {
        await cancelBody(res);
      }
      return { url, finalUrl: res.url || url, status: res.status, headers, html, bytes };
    } catch (err) {
      return failed(describeError(err, timedOut(), PAGE_TIMEOUT_MS));
    }
  });
}

async function loadCheck(url: string): Promise<UrlCheck> {
  if (!resolveHttpUrl(url)) return { url, status: null, ok: false, error: "not an http(s) URL", bytes: null };
  const head = await probe(url, "HEAD");
  // Many servers mishandle HEAD (404/403/405/501 while GET works), so an error status is only
  // trusted once GET agrees; otherwise working links would be reported as broken.
  if (head.status !== null && head.status < 400) return head;
  // A name that does not resolve will not resolve for GET either, and a host that let HEAD
  // time out would double the wait (link checks must fit inside the engine's attempt timeout).
  if (head.status === null && /^(DNS lookup failed|timed out)/.test(head.error ?? "")) return head;
  return probe(url, "GET");
}

async function probe(url: string, method: "HEAD" | "GET"): Promise<UrlCheck> {
  return withTimeout(LINK_TIMEOUT_MS, async (signal, timedOut) => {
    let res: Response;
    try {
      res = await fetch(url, requestInit(method, signal, "*/*"));
    } catch (err) {
      return { url, status: null, ok: false, error: describeError(err, timedOut(), LINK_TIMEOUT_MS), bytes: null };
    }
    const ok = res.status >= 200 && res.status < 400;
    let bytes = parseLength(res.headers.get("content-length"));
    if (method === "GET") {
      try {
        if (ok && bytes === null) bytes = (await readBody(res, 0, MAX_COUNT_BYTES)).total;
        else await cancelBody(res);
      } catch {
        bytes = null;
      }
    }
    return { url, status: res.status, ok, bytes };
  });
}

async function withTimeout<T>(ms: number, run: (signal: AbortSignal, timedOut: () => boolean) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let fired = false;
  const timer = setTimeout(() => {
    fired = true;
    controller.abort();
  }, ms);
  try {
    return await run(controller.signal, () => fired);
  } finally {
    clearTimeout(timer);
  }
}

function requestInit(method: "HEAD" | "GET", signal: AbortSignal, accept: string): RequestInit {
  return {
    method,
    redirect: "follow",
    cache: "no-store",
    signal,
    headers: { "user-agent": USER_AGENT, accept },
  };
}

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    out[name.toLowerCase()] = value;
  });
  return out;
}

function parseLength(value: string | null | undefined): number | null {
  if (!value) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function isTextual(contentType: string): boolean {
  return contentType === "" || /text\/|html|xml|json/i.test(contentType);
}

async function cancelBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // body already consumed or stream errored; nothing to release
  }
}

/** Reads a response body, keeping at most `keepLimit` bytes and counting up to `countLimit`. */
async function readBody(res: Response, keepLimit: number, countLimit: number): Promise<{ data: Buffer; total: number }> {
  if (!res.body) return { data: Buffer.alloc(0), total: 0 };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let kept = 0;
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (kept < keepLimit) {
      const slice = value.subarray(0, keepLimit - kept);
      chunks.push(slice);
      kept += slice.byteLength;
    }
    if (total >= countLimit) {
      await reader.cancel();
      break;
    }
  }
  return { data: Buffer.concat(chunks), total };
}

/** Human-readable network failure, with anything token-like removed. */
function describeError(err: unknown, timedOut: boolean, ms: number): string {
  if (timedOut) return `timed out after ${ms} ms`;
  const cause = (err as { cause?: { code?: unknown; message?: unknown } } | null)?.cause;
  const code = typeof cause?.code === "string" ? cause.code : "";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "EAI_NONAME" || code === "EAI_NODATA") {
    return `DNS lookup failed (${code})`;
  }
  if (code === "ECONNREFUSED") return "connection refused (ECONNREFUSED)";
  if (code === "ECONNRESET") return "connection reset (ECONNRESET)";
  if (/CERT|SSL|TLS/.test(code)) return `TLS error (${code})`;
  if (code) return `network error (${code})`;
  const message = typeof cause?.message === "string" ? cause.message : err instanceof Error ? err.message : String(err);
  return redact(`network error: ${message}`).slice(0, 200);
}

function redact(text: string): string {
  return stripQueries(text)
    .replace(/\b(https?:\/\/)[^\s/@"']+@/gi, "$1[redacted]@")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]");
}
