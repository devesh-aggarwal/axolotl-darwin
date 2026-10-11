// One naming format for workflow steps on every screen: "Accessibility · about", "SEO", "Fix plan".
import { shortPath } from "@/components/ui/tokens";
import type { Capability, NodeView } from "@/lib/types";

export const CAPABILITY_NAME: Record<Capability, string> = {
  crawl: "Crawl",
  accessibility: "Accessibility",
  performance: "Performance",
  seo: "SEO",
  security: "Security headers",
  links: "Broken links",
};

type Named = Pick<NodeView, "kind" | "label"> & Partial<Pick<NodeView, "capability" | "itemKey" | "placeholder">>;

export function stepName(node: Named): string {
  if (node.kind === "builtin" || !node.capability) return node.label;
  const name = CAPABILITY_NAME[node.capability] ?? node.label;
  if (node.placeholder) return `${name} · each page`;
  return node.itemKey ? `${name} · ${shortPath(node.itemKey)}` : name;
}

/** Same format from a stored label (older runs used "Accessibility (WCAG) · contact.html"). */
export function stepNameFromLabel(label: string): string {
  return label
    .replace(/\s*\(WCAG\)/gi, "")
    .replace(/Crawl \/ map/i, "Crawl")
    .replace(/Security headers \/ SSL/i, "Security headers")
    .replace(/\s*\(per page\)/i, " · each page")
    .replace(/\.html?\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Issue text for display, without bracketed rule codes like "[meta-description]" or "[WCAG 1.1.1]". */
export function issueText(text: string): string {
  return text
    .replace(/(^|\s)\[((?:WCAG|SC)\s*[\d.]+|[a-z0-9]+(?:-[a-z0-9]+)+)\](?=[\s.,:;]|$)/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}
