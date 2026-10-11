// zod output contracts for every agent node (verification layer 1).
import { z } from "zod";

export const SeveritySchema = z.enum(["critical", "high", "medium", "low"]);
export const AuditCategorySchema = z.enum(["accessibility", "performance", "seo", "security", "links"]);

export const IssueSchema = z.object({
  category: AuditCategorySchema,
  severity: SeveritySchema,
  rule: z.string().min(1),
  pageUrl: z.string().url(),
  selector: z.string().optional(),
  description: z.string().min(1),
  recommendation: z.string().min(1),
  evidence: z.string(),
});

export const CrawlOutputSchema = z.object({
  pages: z
    .array(
      z.object({
        url: z.string().url(),
        title: z.string(),
        status: z.number().int(),
      }),
    )
    .min(1),
});

export const AuditOutputSchema = z.object({
  issues: z.array(IssueSchema),
  pagesChecked: z.array(z.string().url()),
  summary: z.string().optional(),
});

export type ContractId = "crawl" | "audit";

export const CONTRACTS = {
  crawl: CrawlOutputSchema,
  audit: AuditOutputSchema,
} as const;
