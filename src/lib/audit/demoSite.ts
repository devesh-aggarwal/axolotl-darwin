// Serves files from demo-site/ (used by the Next route and scripts/serve-demo-site.ts).
// Deliberately sets no security headers: their absence is one of the planted issues.
import fs from "node:fs";
import path from "node:path";

export interface DemoSiteFile {
  status: number;
  contentType: string;
  body: Buffer;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
};

/** Files inside demo-site/ that are never served (agents must not read the answers). */
const PRIVATE_FILES = new Set(["ground-truth.json"]);

const NOT_FOUND_BODY =
  "<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\"><title>Not found</title></head>" +
  "<body><h1>404 Not Found</h1><p>This page does not exist.</p></body></html>\n";

export function demoSiteDir(): string {
  return path.resolve(process.env.DEMO_SITE_DIR || path.join(process.cwd(), "demo-site"));
}

/** Reads a file by its path relative to the site root. "" or a directory ⇒ index.html; anything unsafe or missing ⇒ 404. */
export function readDemoSiteFile(relPath: string): DemoSiteFile {
  const file = resolveDemoPath(relPath);
  if (!file) return notFound();
  try {
    return { status: 200, contentType: contentTypeFor(file), body: fs.readFileSync(file) };
  } catch {
    return notFound();
  }
}

export function contentTypeFor(file: string): string {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

function notFound(): DemoSiteFile {
  return { status: 404, contentType: CONTENT_TYPES[".html"], body: Buffer.from(NOT_FOUND_BODY, "utf8") };
}

/** Absolute path of a servable file, or null. Rejects "..", dotfiles, NUL bytes and symlinks that leave the site. */
function resolveDemoPath(relPath: string): string | null {
  if (relPath.includes("\0")) return null;
  const segments = relPath
    .replace(/\\/g, "/")
    .split("/")
    .filter((s) => s !== "" && s !== ".");
  if (segments.some((s) => s === ".." || s.startsWith("."))) return null;

  const root = demoSiteDir();
  let target = path.resolve(root, ...segments);
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  const stat = statOrNull(target);
  if (!stat) return null;
  if (stat.isDirectory()) target = path.join(target, "index.html");
  if (!statOrNull(target)?.isFile()) return null;

  const realRoot = fs.realpathSync(root);
  const real = fs.realpathSync(target);
  if (!real.startsWith(realRoot + path.sep)) return null;
  if (isPrivateFile(realRoot, real)) return null;
  return real;
}

/**
 * Compares by name (case-insensitively) and by file identity, because on case-insensitive
 * filesystems (macOS, Windows) "GROUND-TRUTH.json" opens the same file without matching its name.
 */
function isPrivateFile(realRoot: string, real: string): boolean {
  if (PRIVATE_FILES.has(path.relative(realRoot, real).split(path.sep).join("/").toLowerCase())) return true;
  const target = statOrNull(real);
  if (!target) return true;
  for (const name of PRIVATE_FILES) {
    const secret = statOrNull(path.join(realRoot, name));
    if (secret && secret.dev === target.dev && secret.ino === target.ino) return true;
  }
  return false;
}

function statOrNull(p: string): fs.Stats | null {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}
