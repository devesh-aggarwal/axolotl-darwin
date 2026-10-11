// Tries the translation step's GPT fallback on two answers the rules can't read. At most 2 real
// OpenAI calls (run budget 2; answers are cached, so a rerun costs nothing).
//   npx tsx --tsconfig tsconfig.json --env-file=.env scripts/llm-translate-smoke.ts
import type { AuditOutput } from "@/lib/types";

const CASES = [
  {
    templateId: "seo",
    page: null,
    text:
      "Quick take on the site: the About page shows up untitled in browser tabs and search results, the blog page gives search engines nothing to show under its link, and the pricing page has two competing top-level headings. Crawlers will also find no robots file and no site map at the root. Separately, a few photos have no descriptions for screen readers.",
    expect: ["document-title@about.html", "meta-description@blog.html", "multiple-h1@pricing.html", "robots-txt@", "sitemap@"],
  },
  {
    templateId: "a11y",
    page: "contact.html",
    text:
      "Two things on the contact page: the email and message boxes rely on grey placeholder hints instead of anything a screen reader announces, and the round icon-only control that sends the form is announced as just 'button'.",
    expect: ["label@contact.html", "button-name@contact.html"],
  },
];

async function main(): Promise<void> {
  const { startDemoServer } = await import("./serve-demo-site");
  const { getTemplate } = await import("@/config/workflow");
  const { runCapability } = await import("@/lib/audit");
  const { translateOutput } = await import("@/lib/translate");
  const { verifyOutput } = await import("@/lib/verify");
  const { getLlmUsage } = await import("@/lib/llm/gateway");
  const server = await startDemoServer(0);
  const siteUrl = `${server.origin}/demo-site/`;
  const pages = ((await runCapability("crawl", { siteUrl, maxPages: 10 })) as { pages: { url: string }[] }).pages.map((p) => p.url);
  const budget = { limit: 2, used: 0 };
  console.log("calls today before:", getLlmUsage().dayCalls);

  for (const c of CASES) {
    const template = getTemplate(c.templateId);
    const input = c.page ? { siteUrl, pageUrl: `${siteUrl}${c.page}` } : { siteUrl, pages };
    const tr = await translateOutput(c.text, { template, input, llmMode: "live", llmBudget: budget });
    const out = tr.output as AuditOutput;
    const got = out.issues.map((i) => `${i.rule}@${i.pageUrl.slice(siteUrl.length)}`);
    const missing = c.expect.filter((e) => !got.includes(e));
    const extra = got.filter((g) => !c.expect.includes(g));
    const v = await verifyOutput({ template, input, output: out, siteUrl, crawledPages: pages, seed: 5, llmMode: "mock" });
    console.log(`\n${template.label}: ${tr.note.method} — ${tr.note.text}`);
    console.log("  found:", got.join(", ") || "(none)");
    console.log("  missing:", missing.join(", ") || "none", "| extra:", extra.join(", ") || "none");
    console.log("  verification:", v.pass ? "pass" : `fail (${v.layers.find((l) => !l.pass)?.reason})`);
  }
  console.log("\ncalls used by this script:", budget.used, "| calls today after:", getLlmUsage().dayCalls);
  await server.close();
}

main().catch((err) => {
  console.error("failed:", (err as Error).message);
  process.exit(1);
});
