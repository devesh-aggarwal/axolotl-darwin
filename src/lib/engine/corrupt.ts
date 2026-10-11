// Engine-level output corruption for the "corrupt output" chaos button. Works for any client
// (the mock also corrupts on its own when chaos asks it to). The default is the demo-script
// failure: issues re-pointed at pages that don't exist.
import type { AuditCategory, AuditOutput, CrawlOutput, Issue } from "@/lib/types";

const FAKE_PATHS = ["careers.html", "checkout/", "admin/login", "pricing-enterprise.html", "legal/terms.html"];

function fakePage(siteUrl: string, i: number): string {
  return new URL(FAKE_PATHS[i % FAKE_PATHS.length], siteUrl).toString();
}

export function corruptWithHallucinatedPages(output: unknown, siteUrl: string, category?: AuditCategory): unknown {
  if (!output || typeof output !== "object") return output;
  const o = output as Partial<AuditOutput & CrawlOutput>;
  if (Array.isArray(o.pages)) {
    const pages = [
      ...o.pages,
      { url: fakePage(siteUrl, 0), title: "Careers", status: 200 },
      { url: fakePage(siteUrl, 1), title: "Checkout", status: 200 },
    ];
    return { ...o, pages };
  }
  if (Array.isArray(o.issues)) {
    const source: Issue[] = o.issues.length ? o.issues : [placeholderIssue(siteUrl, category ?? "seo")];
    const issues = source.map((issue, i) => ({ ...issue, pageUrl: fakePage(siteUrl, i) }));
    const pagesChecked = [...new Set(issues.map((i) => i.pageUrl))];
    return { ...o, issues, pagesChecked };
  }
  return output;
}

function placeholderIssue(siteUrl: string, category: AuditCategory): Issue {
  return {
    category,
    severity: "high",
    rule: category === "seo" ? "document-title" : category === "links" ? "broken-link" : "image-alt",
    pageUrl: siteUrl,
    description: "Page is missing critical markup",
    recommendation: "Add the missing markup",
    evidence: "Observed during audit",
  };
}
