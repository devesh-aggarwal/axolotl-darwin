// Serves demo-site/ locally. Deliberately sends NO security headers (they are planted issues).
import { readDemoSiteFile } from "@/lib/audit/demoSite";

export const runtime = "nodejs";

const MOUNT = "/demo-site";

/**
 * Decodes the raw request path exactly once (like scripts/serve-demo-site.ts). Next's params are
 * already decoded, so decoding them again served "%252E" as "." and threw (500) on a literal "%".
 */
function relPath(pathname: string): string {
  try {
    return decodeURIComponent(pathname.slice(MOUNT.length + 1));
  } catch {
    return "\0"; // never servable
  }
}

export async function GET(req: Request) {
  const { pathname } = new URL(req.url);
  if (pathname === MOUNT) {
    return new Response(null, { status: 308, headers: { location: `${MOUNT}/` } });
  }
  const file = readDemoSiteFile(pathname.startsWith(`${MOUNT}/`) ? relPath(pathname) : "\0");
  return new Response(new Uint8Array(file.body), {
    status: file.status,
    headers: { "content-type": file.contentType, "cache-control": "no-store" },
  });
}

export async function HEAD(req: Request) {
  const res = await GET(req);
  const len = res.body ? (await res.arrayBuffer()).byteLength : 0;
  const headers = new Headers(res.headers);
  headers.set("content-length", String(len));
  return new Response(null, { status: res.status, headers });
}
