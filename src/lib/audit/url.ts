// URL helpers shared by the audit toolkit, ground truth matching and verification.

/** Resolves `href` against `base` and drops the fragment. Returns null for unparsable or non-http(s) URLs. */
export function resolveHttpUrl(href: string, base?: string): string | null {
  let u: URL;
  try {
    u = base === undefined ? new URL(href.trim()) : new URL(href.trim(), base);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  u.hash = "";
  return u.toString();
}

/**
 * Canonical page URL: absolute, no query or hash, trailing `index.html` removed
 * (`…/demo-site/index.html` ≡ `…/demo-site/`). Unparsable input is returned trimmed.
 */
export function normalizeUrl(url: string, base?: string): string {
  let u: URL;
  try {
    u = base === undefined ? new URL(url.trim()) : new URL(url.trim(), base);
  } catch {
    return url.trim();
  }
  u.hash = "";
  u.search = "";
  if (u.pathname.endsWith("/index.html")) {
    u.pathname = u.pathname.slice(0, -"index.html".length);
  }
  return u.toString();
}

/** True when both URLs parse and share scheme, host and port. */
export function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/**
 * The site root used for site-wide issues: the normalized site URL, with a trailing
 * slash added when the last path segment looks like a directory (`/demo-site` ⇒ `/demo-site/`).
 */
export function siteRootUrl(siteUrl: string): string {
  const normalized = normalizeUrl(siteUrl);
  let u: URL;
  try {
    u = new URL(normalized);
  } catch {
    return normalized;
  }
  const last = u.pathname.split("/").pop() ?? "";
  if (last !== "" && !last.includes(".")) u.pathname = `${u.pathname}/`;
  return u.toString();
}

/** Directory part of a URL's path, always ending in "/". */
export function urlDirectory(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname.slice(0, u.pathname.lastIndexOf("/") + 1);
  } catch {
    return "/";
  }
}

/** Same origin as `root` and inside the root's directory. */
export function isWithinSite(url: string, root: string): boolean {
  if (!sameOrigin(url, root)) return false;
  try {
    return new URL(url).pathname.startsWith(urlDirectory(root));
  } catch {
    return false;
  }
}

/** Removes query strings from URLs embedded in free text (they may carry tokens). */
export function stripQueries(text: string): string {
  return text.replace(/(https?:\/\/[^\s?#"']+)[?#][^\s"']*/g, "$1");
}

/** The href from an `a[href="…"]` selector with CSS escapes undone; null for any other selector shape. */
export function hrefFromLinkSelector(selector: string | undefined): string | null {
  const m = /^\s*a\[href=(["'])((?:\\.|(?!\1).)*)\1\]\s*$/.exec(selector ?? "");
  return m ? cssUnescape(m[2]) : null;
}

/** Single pass, so an escaped backslash followed by "a" is not mistaken for the `\a ` newline escape. */
function cssUnescape(value: string): string {
  return value.replace(/\\(?:([0-9a-fA-F]{1,6}) ?|([\s\S]))/g, (_, hex: string | undefined, ch: string | undefined) => {
    if (hex === undefined) return ch ?? "";
    const code = parseInt(hex, 16);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "�";
  });
}

/** Every http(s) URL that appears in a piece of text. */
export function urlsInText(text: string): string[] {
  return text.match(/https?:\/\/[^\s"'<>()]+/g)?.map((u) => u.replace(/[.,;:]+$/, "")) ?? [];
}
