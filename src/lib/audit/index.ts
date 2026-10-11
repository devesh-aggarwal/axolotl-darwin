// Public API of the local auditing toolkit.
import type { AgentNodeInput, AuditOutput, Capability, CrawlInput, CrawlOutput, PageAuditInput, SiteAuditInput } from "@/lib/types";
import { DEFAULTS } from "@/config/workflow";
import { auditPage, auditSite, crawlSite } from "@/lib/audit/analyzers";

/** Runs one capability locally: the "perfect agent" output for a node input. */
export async function runCapability(capability: Capability, input: AgentNodeInput): Promise<CrawlOutput | AuditOutput> {
  switch (capability) {
    case "crawl":
      return crawlSite(asCrawlInput(input));
    case "accessibility":
    case "performance":
      return auditPage(capability, asPageInput(input, capability));
    case "seo":
    case "security":
    case "links":
      return auditSite(capability, asSiteInput(input, capability));
    default:
      throw new Error(`Unknown capability: ${String(capability)}`);
  }
}

function field(input: AgentNodeInput, key: string): unknown {
  return (input as unknown as Record<string, unknown>)[key];
}

function requireString(input: AgentNodeInput, key: string, capability: Capability): string {
  const value = field(input, key);
  if (typeof value !== "string" || value.trim() === "") throw new Error(`runCapability(${capability}) needs a "${key}" string`);
  return value;
}

function asCrawlInput(input: AgentNodeInput): CrawlInput {
  const maxPages = field(input, "maxPages");
  return {
    siteUrl: requireString(input, "siteUrl", "crawl"),
    maxPages: typeof maxPages === "number" && maxPages > 0 ? maxPages : DEFAULTS.maxPages,
  };
}

function asPageInput(input: AgentNodeInput, capability: Capability): PageAuditInput {
  const pageUrl = requireString(input, "pageUrl", capability);
  const siteUrl = field(input, "siteUrl");
  return { siteUrl: typeof siteUrl === "string" ? siteUrl : pageUrl, pageUrl };
}

function asSiteInput(input: AgentNodeInput, capability: Capability): SiteAuditInput {
  const pages = field(input, "pages");
  return {
    siteUrl: requireString(input, "siteUrl", capability),
    pages: Array.isArray(pages) ? pages.filter((p): p is string => typeof p === "string") : [],
  };
}

export { crawlSite, auditPage, auditSite, selectorFor, parseCssColor, contrastRatio } from "@/lib/audit/analyzers";
export { fetchPage, checkUrl, clearFetchCache, isHtmlResponse, mapLimit } from "@/lib/audit/fetcher";
export type { FetchedPage, UrlCheck } from "@/lib/audit/fetcher";
export { RULES, getRule, rulesForCategory, buildIssue, OVERSIZED_IMAGE_BYTES, MIN_CONTRAST_RATIO } from "@/lib/audit/rules";
export type { RuleDef } from "@/lib/audit/rules";
export { spotCheckIssues, verifyClaim, SPOT_CHECKABLE_RULES } from "@/lib/audit/spotcheck";
export type { SpotCheckResult, SpotCheckSample, SpotCheckVerdict } from "@/lib/audit/spotcheck";
export {
  loadGroundTruth,
  isDemoSite,
  expectedPages,
  expectedIssues,
  matchesGroundTruth,
  measureRecall,
  unmatchedIssues,
} from "@/lib/audit/groundTruth";
export type { GroundTruth, GroundTruthIssue, ResolvedGroundTruthIssue, GroundTruthFilter } from "@/lib/audit/groundTruth";
export { readDemoSiteFile, demoSiteDir, contentTypeFor } from "@/lib/audit/demoSite";
export type { DemoSiteFile } from "@/lib/audit/demoSite";
export {
  normalizeUrl,
  resolveHttpUrl,
  sameOrigin,
  siteRootUrl,
  isWithinSite,
  urlDirectory,
  urlsInText,
  hrefFromLinkSelector,
} from "@/lib/audit/url";
