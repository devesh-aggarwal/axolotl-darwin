// Serves demo-site/ at http://127.0.0.1:<port>/demo-site/ with no security headers.
// Usage: npx tsx --tsconfig tsconfig.json scripts/serve-demo-site.ts [port]
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { readDemoSiteFile } from "@/lib/audit/demoSite";

const MOUNT = "/demo-site";
const DEFAULT_PORT = 4321;

export interface DemoServer {
  origin: string;
  close(): Promise<void>;
}

export function startDemoServer(port: number = DEFAULT_PORT): Promise<DemoServer> {
  const server = http.createServer(handleRequest);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      const { port: bound } = server.address() as AddressInfo;
      resolve({ origin: `http://127.0.0.1:${bound}`, close: () => closeServer(server) });
    });
  });
}

function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  const method = req.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") {
    send(res, method, 405, "text/plain; charset=utf-8", Buffer.from("Method not allowed\n"), { allow: "GET, HEAD" });
    return;
  }
  let url: URL;
  try {
    url = new URL(req.url ?? "/", "http://demo.local");
  } catch {
    send(res, method, 400, "text/plain; charset=utf-8", Buffer.from("Bad request\n"));
    return;
  }
  if (url.pathname === "/" || url.pathname === MOUNT) {
    send(res, method, 301, "text/plain; charset=utf-8", Buffer.from(`Moved to ${MOUNT}/\n`), { location: `${MOUNT}/${url.search}` });
    return;
  }
  const file = url.pathname.startsWith(`${MOUNT}/`) ? readDemoSiteFile(decodePath(url.pathname.slice(MOUNT.length + 1))) : readDemoSiteFile("\0");
  send(res, method, file.status, file.contentType, file.body);
}

/** Percent-decodes a path; undecodable input becomes a path that can never be served. */
function decodePath(p: string): string {
  try {
    return decodeURIComponent(p);
  } catch {
    return "\0";
  }
}

function send(
  res: http.ServerResponse,
  method: string,
  status: number,
  contentType: string,
  body: Buffer,
  extra: Record<string, string> = {},
): void {
  res.writeHead(status, { "content-type": contentType, "content-length": String(body.length), "cache-control": "no-cache", ...extra });
  res.end(method === "HEAD" ? undefined : body);
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
    server.closeAllConnections();
  });
}

function isDirectRun(): boolean {
  return /^serve-demo-site\.(ts|js|mjs|cjs)$/.test(path.basename(process.argv[1] ?? ""));
}

if (isDirectRun()) {
  const arg = Number(process.argv[2]);
  const port = Number.isInteger(arg) && arg >= 0 ? arg : DEFAULT_PORT;
  startDemoServer(port).then(
    ({ origin }) => console.log(`Demo site: ${origin}${MOUNT}/`),
    (err: unknown) => {
      console.error(`Could not start the demo site server: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    },
  );
}
