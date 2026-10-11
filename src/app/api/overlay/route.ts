// Issue overlay (spec 6.8): the audited page with every flagged element highlighted in place.
import { randomBytes } from "node:crypto";
import { cleanText, siteWidePhrase } from "@/components/report/planText";
import { RULES } from "@/lib/audit/rules";
import { fetchPage } from "@/lib/audit/fetcher";
import { fail, handle } from "@/lib/api";
import { getRunRecord } from "@/lib/engine/runtime";
import type { CrawlOutput, PrioritizedOutput } from "@/lib/types";

export const runtime = "nodejs";

// The audited page can't see the app's CSS variables, so the severity colors are spelled out here
// (same values as --s-failed, --s-partial, --s-verifying and --s-running in globals.css).
const SEV: Record<string, string> = { critical: "#e04450", high: "#df7a2c", medium: "#cc8a00", low: "#2f6fed" };

/** Plainer names for the few rule titles that read as jargon on the page itself. */
const PLAIN_TITLE: Record<string, string> = {
  "render-blocking-script": "Script holds up the page",
  "unsized-image": "Image has no set size",
  "multiple-h1": "More than one main heading",
  "html-has-lang": "Page language not set",
};

function plainTitle(i: { rule: string; description: string }): string {
  return PLAIN_TITLE[i.rule] ?? RULES[i.rule]?.title ?? cleanText(i.description);
}

function norm(u: string): string {
  try {
    const url = new URL(u);
    url.hash = "";
    url.search = "";
    return url.toString().replace(/index\.html$/, "");
  } catch {
    return u;
  }
}

/** Same origin and inside the site root's directory: /demo-site/ must not open /api/* on the same host. */
function inSite(u: URL, site: URL): boolean {
  const base = site.pathname.slice(0, site.pathname.lastIndexOf("/") + 1);
  return u.origin === site.origin && u.pathname.startsWith(base);
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export const GET = handle(async (req: Request) => {
  const url = new URL(req.url);
  const runId = url.searchParams.get("runId") ?? "";
  const rec = getRunRecord(runId);
  if (!rec) return fail(404, "Run not found");
  const site = new URL(rec.run.config.siteUrl);
  const page = url.searchParams.get("page") || site.toString();
  let target: URL;
  try {
    target = new URL(page);
  } catch {
    return fail(400, "Bad page URL");
  }
  // Only the site root and the pages this run actually crawled can be opened.
  const crawled = (rec.nodes.find((n) => n.templateId === "crawl")?.output as CrawlOutput | undefined)?.pages ?? [];
  const allowed = new Set([norm(site.toString()), ...crawled.map((p) => norm(p.url))]);
  if (!inSite(target, site) || !allowed.has(norm(target.toString()))) return fail(400, "Page is outside the audited site");

  const prioritized = rec.nodes.find((n) => n.templateId === "prioritize")?.output as PrioritizedOutput | undefined;
  const issues = prioritized?.issues ?? [];
  const here = issues.filter((i) => norm(i.pageUrl) === norm(target.toString()) && RULES[i.rule]?.scope !== "site");
  const siteWide = issues.filter((i) => RULES[i.rule]?.scope === "site");

  const fetched = await fetchPage(target.toString());
  let final: URL | null = null;
  try {
    final = new URL(fetched.finalUrl || target.toString());
  } catch {
    // treated as outside below
  }
  if (!final || !inSite(final, site)) return fail(502, "The page redirected outside the audited site");
  if (!fetched.html) return fail(502, `Could not load ${target} (status ${fetched.status})`);
  // The audited page is untrusted HTML served from our origin: only our nonce'd highlighter may run.
  const nonce = randomBytes(16).toString("base64");

  const marks = here
    .filter((i) => i.selector)
    .map((i) => ({ selector: i.selector!, label: plainTitle(i), severity: i.severity }));
  // Problems with no element to outline (a missing title, say) are named in the bar instead.
  const unplaced = here.filter((i) => !i.selector).map(plainTitle);

  const inject = `
<base href="${esc(target.toString())}">
<style>
  .axl-flag{outline:2px solid var(--axl-c,${SEV.critical})!important;outline-offset:3px!important;border-radius:2px}
  .axl-tag{position:absolute;z-index:2147483647;font:500 11.5px/1.35 Inter,system-ui,sans-serif;background:var(--axl-c,${SEV.critical});color:#fff;padding:2px 7px;border-radius:999px;pointer-events:none;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,.18)}
  .axl-bar{position:sticky;top:0;z-index:2147483646;display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 14px;background:#fff;color:#45453f;font:13px/1.5 Inter,system-ui,sans-serif;padding:8px 16px;border-bottom:1px solid #e8e7e3;box-shadow:0 2px 8px rgba(0,0,0,.05);text-align:left}
  .axl-bar b{font-weight:600;color:#1d1d1b}.axl-bar .axl-muted{color:#76756e}.axl-bar [hidden]{display:none}
</style>`;
  const script = `
<script nonce="${nonce}">
(function(){
  var marks = ${JSON.stringify(marks).replace(/</g, "\\u003c")};
  var unplaced = ${JSON.stringify(unplaced).replace(/</g, "\\u003c")};
  var colors = ${JSON.stringify(SEV)};
  function place(){
    document.querySelectorAll('.axl-tag').forEach(function(t){t.remove()});
    var hidden = unplaced.slice();
    marks.forEach(function(m){
      var els=[]; try{els=document.querySelectorAll(m.selector)}catch(e){}
      var shown=0;
      els.forEach(function(el){
        var c = colors[m.severity]||colors.critical;
        var r=el.getBoundingClientRect();
        if((!r.width && !r.height) || el===document.documentElement || el===document.body) return;
        shown++;
        el.classList.add('axl-flag'); el.style.setProperty('--axl-c', c);
        var tag=document.createElement('div'); tag.className='axl-tag';
        tag.style.setProperty('--axl-c', c);
        tag.textContent=m.label; tag.style.left=(window.scrollX+r.left)+'px'; tag.style.top=Math.max(0,window.scrollY+r.top-22)+'px';
        document.body.appendChild(tag);
      });
      if(!shown && hidden.indexOf(m.label)<0) hidden.push(m.label);
    });
    var box=document.getElementById('axl-hidden');
    if(box){ box.hidden=!hidden.length; box.textContent=hidden.length?('Also on this page: '+hidden.join(', ')):''; }
  }
  window.addEventListener('load', place); window.addEventListener('resize', place); setTimeout(place, 300);
})();
</script>`;
  // Same count on every page: this page's own problems. Site-wide ones get one line of their own.
  const count = here.length;
  const like = siteWidePhrase(siteWide);
  const siteLine = siteWide.length
    ? `<span class="axl-muted">+${siteWide.length} site-wide problem${siteWide.length === 1 ? `: ${esc(like)}` : `s, like ${esc(like)}`}</span>`
    : "";
  const bannerHtml = `<div class="axl-bar"><b>${count ? `${count} problem${count === 1 ? "" : "s"} on this page` : "No problems on this page"}</b><span id="axl-hidden" class="axl-muted" hidden></span>${siteLine}</div>`;

  // The audited page's own scripts never run on our origin; only our highlighter does.
  let html = fetched.html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, "")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + inject) : inject + html;
  html = /<body[^>]*>/i.test(html) ? html.replace(/<body[^>]*>/i, (m) => m + bannerHtml) : bannerHtml + html;
  html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, script + "</body>") : html + script;
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    "style-src * 'unsafe-inline'",
    "img-src * data: blob:",
    "font-src * data:",
    "media-src *",
    `base-uri ${target.origin}`,
    "form-action 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "connect-src 'none'",
  ].join("; ");
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": csp },
  });
});
