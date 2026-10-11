// Local test agents answer in the formats real agents use (axe-core JSON, Lighthouse JSON, Markdown,
// prose, tables) instead of Axolotl's own, so the translation step and direct connection can be
// tested end to end without Darwin. Findings come from Axolotl's own analyzers.
import { getRule } from "@/lib/audit/rules";
import { siteRootUrl } from "@/lib/audit/url";
import type { AuditOutput, CrawlOutput, Issue, Severity } from "@/lib/types";

export type AnswerStyle = "markdown-links" | "axe" | "lighthouse" | "markdown" | "prose" | "table";

function relPath(url: string, siteUrl: string): string {
  const root = siteRootUrl(siteUrl);
  return url.startsWith(root) ? url.slice(root.length) || "/" : url;
}

const AXE_IMPACT: Record<Severity, string> = { critical: "critical", high: "serious", medium: "moderate", low: "minor" };

function byRule(issues: Issue[]): Map<string, Issue[]> {
  const groups = new Map<string, Issue[]>();
  for (const i of issues) groups.set(i.rule, [...(groups.get(i.rule) ?? []), i]);
  return groups;
}

/** Image or script URL quoted in an issue's evidence, for Lighthouse "items". */
function assetUrl(issue: Issue): string | undefined {
  return /https?:\/\/\S+?\.(?:jpe?g|png|gif|webp|svg|avif|js)\b/i.exec(issue.evidence)?.[0];
}

function bytesIn(issue: Issue): number | undefined {
  const m = /(\d[\d,.]*)\s*(bytes|kb|mb)\b/i.exec(issue.evidence);
  if (!m) return undefined;
  const n = Number(m[1].replace(/,/g, ""));
  const unit = m[2].toLowerCase();
  return Math.round(unit === "mb" ? n * 1024 * 1024 : unit === "kb" ? n * 1024 : n);
}

const LIGHTHOUSE_IDS: Record<string, { id: string; title: string }> = {
  "oversized-image": { id: "uses-optimized-images", title: "Efficiently encode images" },
  "unsized-image": { id: "unsized-images", title: "Image elements do not have explicit `width` and `height`" },
  "render-blocking-script": { id: "render-blocking-resources", title: "Eliminate render-blocking resources" },
};

export function renderCrawl(out: CrawlOutput, style: AnswerStyle): string {
  if (style === "markdown-links") {
    return [`Found ${out.pages.length} pages:`, "", ...out.pages.map((p) => `- [${p.title || p.url}](${p.url})`)].join("\n");
  }
  return out.pages.map((p) => p.url).join("\n");
}

export function renderAudit(out: AuditOutput, style: AnswerStyle, siteUrl: string): unknown {
  switch (style) {
    case "axe":
      return {
        testEngine: { name: "axe-core", version: "4.10.2" },
        url: out.pagesChecked[0] ?? siteUrl,
        violations: [...byRule(out.issues)].map(([rule, issues]) => ({
          id: rule,
          impact: AXE_IMPACT[issues[0].severity],
          help: getRule(rule)?.title ?? rule,
          description: issues[0].description,
          nodes: issues.map((i) => ({ target: i.selector ? [i.selector] : ["html"], html: i.evidence, failureSummary: i.recommendation })),
        })),
        passes: [],
      };
    case "lighthouse": {
      const audits: Record<string, unknown> = { "first-contentful-paint": { score: 0.95, title: "First Contentful Paint", displayValue: "0.8 s" } };
      for (const [rule, issues] of byRule(out.issues)) {
        const lh = LIGHTHOUSE_IDS[rule] ?? { id: rule, title: getRule(rule)?.title ?? rule };
        audits[lh.id] = {
          id: lh.id,
          title: lh.title,
          score: 0.4,
          scoreDisplayMode: "metricSavings",
          details: {
            type: "opportunity",
            items: issues.map((i) => ({ url: assetUrl(i), totalBytes: bytesIn(i), node: i.selector ? { selector: i.selector, snippet: i.evidence } : undefined })),
          },
        };
      }
      return { lighthouseVersion: "12.2.0", finalDisplayedUrl: out.pagesChecked[0] ?? siteUrl, audits };
    }
    case "markdown": {
      const lines = [`# SEO review of ${siteUrl}`, ""];
      const byPage = new Map<string, Issue[]>();
      for (const i of out.issues) byPage.set(i.pageUrl, [...(byPage.get(i.pageUrl) ?? []), i]);
      for (const [page, issues] of byPage) {
        lines.push(`## ${relPath(page, siteUrl)}`, "");
        for (const i of issues) lines.push(`- **${getRule(i.rule)?.title ?? i.rule}** (${i.severity}): ${i.description}`);
        lines.push("");
      }
      if (!out.issues.length) lines.push("No issues found.");
      lines.push("Everything else looked fine.");
      return lines.join("\n");
    }
    case "prose": {
      if (!out.issues.length) return `I checked the response headers for ${siteUrl} and no issues were found.`;
      const sentences = out.issues.map((i) => `${getRule(i.rule)?.title ?? i.rule} on ${i.pageUrl}: ${i.description.replace(/\.$/, "")}.`);
      return `I checked the response headers and forms for ${siteUrl}. ${sentences.join(" ")} I'd fix the high-severity ones first.`;
    }
    case "table": {
      const rows = out.issues.map((i) => {
        const target = /https?:\/\/\S+/.exec(i.evidence)?.[0]?.replace(/[.,;]+$/, "") ?? "";
        const status = /\b([45]\d\d)\b/.exec(i.evidence)?.[1] ?? "error";
        return `| ${relPath(i.pageUrl, siteUrl)} | ${target} | ${status} |`;
      });
      return ["Link check finished.", "", "| Page | Broken link | Status |", "| --- | --- | --- |", ...rows].join("\n");
    }
    default:
      return out;
  }
}
