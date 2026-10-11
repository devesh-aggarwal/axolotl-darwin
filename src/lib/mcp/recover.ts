// Failure triage: given what an agent was trying to do and how it failed, say what kind of failure
// it was and the next concrete move, instead of handing the problem back to the person.
import { routeAgents } from "@/lib/mcp/agents";

export type FailureKind = "needs_input" | "capability_missing" | "auth_or_payment" | "transient" | "wrong_output" | "unknown";

export interface RecoveryPlan {
  kind: FailureKind;
  diagnosis: string;
  nextAction: string;
  /** An Axolotl tool that can take over, with suggested arguments. */
  useTool?: { name: string; arguments: Record<string, unknown> };
  alternatives: Record<string, unknown>[];
  searchNote?: string;
}

const PATTERNS: [FailureKind, RegExp][] = [
  ["auth_or_payment", /\b(log ?in|sign ?in|authenticat|authori[sz]|credential|password|payment|billing|credit card|subscribe|401|403)\b/i],
  ["transient", /\b(time[sd]? ?out|timed out|rate.?limit|429|50[0234]|temporar|try again later|unavailable|connection (reset|refused|closed)|network)\b/i],
  ["needs_input", /\b(what('| i)s your|please (provide|share|tell)|need (your|the|a) (full )?(address|street|zip|location)|street (number|name)|zip code|which (one|location)|requires? a full address)\b/i],
  ["capability_missing", /\b(can(no|')t|cannot|could(n'?t| not)|unable to|not able to|doesn'?t support|does not support|only (supports?|exposes|has|offers|provides|search(es)?)|not supported|no (tool|way) to|has no [\w-]+( [\w-]+)? (tool|action|function)|limitation|overstated)\b/i],
  ["wrong_output", /\b(wrong|incorrect|mismatch|invalid|malformed|hallucinat|doesn'?t match)\b/i],
];

export function classify(text: string): FailureKind {
  for (const [kind, re] of PATTERNS) if (re.test(text)) return kind;
  return "unknown";
}

const FOOD = /\b(food|order|deliver|delivery|cart|uber ?eats|doordash|grubhub|restaurant|bakery|pizza|crepe|crêpe|meal|lunch|dinner)\b/i;
// Most specific first: "deliver to X" beats a stray "to my cart".
const PLACE_PATTERNS = [/deliver(?:ed|y)?\s+to\s+(?:the\s+)?([^.,;\n]{3,60})/i, /address(?: is)?\s+([^.,;\n]{3,60})/i, /\bat\s+(?:the\s+)?([^.,;\n]{3,60})/i];

function placeFragment(...texts: string[]): string | undefined {
  for (const re of PLACE_PATTERNS) {
    for (const t of texts) {
      const hit = re.exec(t)?.[1]?.trim();
      if (hit && !/\b(cart|order|plugin|tool)\b/i.test(hit)) return hit;
    }
  }
  return undefined;
}

export async function planRecovery(goal: string, failure: string, failedTool?: string): Promise<RecoveryPlan> {
  const kind = classify(failure);
  const isFood = FOOD.test(`${goal} ${failedTool ?? ""}`);
  const plan: RecoveryPlan = { kind, diagnosis: "", nextAction: "", alternatives: [] };

  switch (kind) {
    case "needs_input": {
      const fragment = placeFragment(goal, failure);
      plan.diagnosis = "The agent stopped to ask for something a lookup could answer.";
      plan.nextAction = fragment
        ? `Don't ask the person. Call axolotl_resolve_place with "${fragment}" and pass the verified address back to the failed tool.`
        : "Don't ask the person yet. If the missing piece is a place or address, call axolotl_resolve_place with whatever name or fragment you already have.";
      if (fragment) plan.useTool = { name: "axolotl_resolve_place", arguments: { query: fragment } };
      break;
    }
    case "capability_missing":
      plan.diagnosis = `${failedTool ?? "The tool"} can't do this step at all; retrying it won't help. Switch to an agent that has the capability.`;
      plan.nextAction = isFood
        ? "Call axolotl_add_to_cart with host_tools listing your delivery plugins (and can_browse if you have a browser). It plans which of your tools to use, in order, and axolotl_verify_cart checks each real cart."
        : "Pick one of the alternatives below (found on Darwin) for this step.";
      if (isFood) plan.useTool = { name: "axolotl_add_to_cart", arguments: { item: "<what they asked for>", deliver_to: "<place or address as they said it>", host_tools: ["<your delivery plugins>"], can_browse: true } };
      break;
    case "auth_or_payment":
      plan.diagnosis = "The step hit a login or payment wall.";
      plan.nextAction = "Don't bypass it. Switch to an alternative that needs no sign-in or payment (the list below already leaves those out), or ask the person to handle this one.";
      break;
    case "transient":
      plan.diagnosis = "Looks temporary (timeout, rate limit or server error).";
      plan.nextAction = "Retry the identical request once. If it fails again, switch to an alternative instead of retrying further.";
      break;
    case "wrong_output":
      plan.diagnosis = "The step answered, but the answer is wrong. That's a silent failure; don't pass it on.";
      plan.nextAction = "Discard the answer and run the step on an alternative agent, then check the new answer against the request.";
      break;
    default:
      plan.diagnosis = "Couldn't tell what kind of failure this was from the text.";
      plan.nextAction = "Try an alternative agent for the step before going back to the person.";
  }

  if (kind !== "needs_input") {
    try {
      // Darwin matches capabilities, not whole requests; a known domain gets a capability-shaped query.
      const query = isFood ? "food delivery agent that adds restaurant menu items to a cart for delivery" : goal;
      const r = await routeAgents(query);
      plan.alternatives = r.runnable.slice(0, 4).map((a) => ({ name: a.agent.name, tier: a.tier, why: a.reason, what: a.candidate?.description.slice(0, 200) ?? "" }));
      const left = r.skipped.length ? `; ${r.skipped.length} found but left out (first: ${r.skipped[0].agent.name}, ${r.skipped[0].reason.toLowerCase()})` : "";
      plan.searchNote = r.runnable.length ? `Darwin agents that can run now for "${query}"${left}` : `No Darwin agent for "${query}" can run unattended right now${left}`;
    } catch (err) {
      plan.searchNote = `Darwin search failed (${(err as Error).message})`;
    }
  }
  return plan;
}
