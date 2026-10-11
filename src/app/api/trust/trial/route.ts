// Trial run: give one agent setup has found a task on the demo site and score what it gets right.
// The agent is looked up from what search returned, so the browser can't point a trial at any address.
import { getTemplate } from "@/config/workflow";
import { body, fail, handle, ok } from "@/lib/api";
import { publish } from "@/lib/events";
import { getListing, trustFor } from "@/lib/trust/store";
import { runTrial } from "@/lib/trust/trial";
import type { Capability } from "@/lib/types";

export const runtime = "nodejs";

/** One trial per agent at a time. */
const running = new Set<string>();

export const POST = handle(async (req: Request) => {
  const b = await body<{ templateId: string; agentId: string }>(req);
  let template;
  try {
    template = getTemplate(String(b.templateId ?? ""));
  } catch {
    return fail(400, "Unknown templateId");
  }
  if (template.kind !== "agent" || !template.capability) return fail(400, "That step runs inside Axolotl; nothing to try");
  const capability = template.capability as Capability;
  const listing = typeof b.agentId === "string" ? getListing(b.agentId, capability) : null;
  if (!listing) return fail(404, "Search for this agent first");
  const key = `${listing.agentId}|${capability}`;
  if (running.has(key)) return fail(409, "A trial for this agent is already running");
  if (trustFor(listing).verdict === "avoid") return fail(422, "This agent failed its safety check, so Axolotl won't call it");
  running.add(key);
  try {
    const trial = await runTrial(listing, capability);
    publish({ type: "stats_updated", at: Date.now() });
    return ok({ trial, trust: trustFor(listing) });
  } finally {
    running.delete(key);
  }
});
