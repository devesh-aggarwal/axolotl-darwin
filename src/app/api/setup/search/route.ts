// Setup step 1: search Darwin (or the mock catalog) for each node's capability.
import { getTemplate } from "@/config/workflow";
import { fail, handle, ok } from "@/lib/api";
import { getDarwinClient } from "@/lib/engine/clients";
import { withTrust } from "@/lib/trust/store";
import type { Capability } from "@/lib/types";

export const runtime = "nodejs";

export const GET = handle(async (req: Request) => {
  const url = new URL(req.url);
  const templateId = url.searchParams.get("templateId") ?? "";
  const client = url.searchParams.get("client") === "darwin" ? "darwin" : "mock";
  let template;
  try {
    template = getTemplate(templateId);
  } catch {
    return fail(400, "Unknown templateId");
  }
  if (template.kind !== "agent" || !template.query) return fail(400, "That node runs inside Axolotl; nothing to search");
  const query = url.searchParams.get("query")?.trim() || template.query;
  try {
    const result = await getDarwinClient(client).search(query, { maxResults: 6, capability: template.capability as Capability });
    const { searchToken: _searchToken, ...safe } = result;
    // First-sight trust check on every result: safety, cost, and (once tried) quality.
    return ok({ templateId, client, ...safe, agents: withTrust(safe.agents) });
  } catch (err) {
    return fail(502, `Search failed: ${(err as Error).message}`);
  }
});
