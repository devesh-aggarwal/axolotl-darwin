// Small helpers shared by route handlers.
export function ok(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, { ...init, headers: { "cache-control": "no-store", ...(init?.headers ?? {}) } });
}

export function fail(status: number, message: string): Response {
  return Response.json({ error: message }, { status, headers: { "cache-control": "no-store" } });
}

/** Parsed JSON object body; anything else (empty, invalid, null, arrays, primitives) becomes {}. */
export async function body<T>(req: Request): Promise<Partial<T>> {
  try {
    const text = await req.text();
    if (!text) return {};
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Partial<T>) : {};
  } catch {
    return {};
  }
}

/**
 * Refuse state-changing requests from other websites. A page elsewhere could otherwise make the
 * browser POST to this local server (start a GPT-reviewed run, overwrite pools). Browsers mark
 * cross-site requests with Sec-Fetch-Site / Origin; scripts and curl send neither.
 */
function crossSiteRefusal(req: Request): string | null {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return null;
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return "Cross-site requests are not allowed";
  const origin = req.headers.get("origin");
  if (origin) {
    try {
      if (new URL(origin).host !== new URL(req.url).host) return "Cross-site requests are not allowed";
    } catch {
      return "Bad Origin header";
    }
  }
  const length = Number(req.headers.get("content-length") ?? "0");
  const type = req.headers.get("content-type") ?? "";
  if (length > 0 && !type.toLowerCase().includes("application/json")) return "Send JSON (content-type: application/json)";
  return null;
}

/** Wrap a handler: cross-site writes are refused, and unexpected errors become a generic JSON 500. */
export function handle<A extends unknown[]>(fn: (...args: A) => Promise<Response> | Response) {
  return async (...args: A): Promise<Response> => {
    const req = args[0] instanceof Request ? args[0] : null;
    if (req) {
      const refusal = crossSiteRefusal(req);
      if (refusal) return fail(403, refusal);
    }
    try {
      return await fn(...args);
    } catch (err) {
      const msg = String((err as Error)?.message ?? err)
        .replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]")
        .replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
      console.error("[api]", msg);
      return fail(500, "Something went wrong on the server. Check the server log for details.");
    }
  };
}
