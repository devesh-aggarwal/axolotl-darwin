#!/usr/bin/env node
// Axolotl auto-trigger: a Stop hook for Claude Code and Codex.
// When the agent is about to end its turn by giving up ("I can't add items to your cart") or by asking
// the person for something a lookup could answer ("what's your street address?"), the hook blocks the
// stop once and tells the agent to hand the failure to Axolotl's MCP tools first.
// Reads the hook payload on stdin; prints a decision on stdout. Never fails the host: any error = allow.
import { appendFileSync, readFileSync } from "node:fs";

/** Set AXOLOTL_HOOK_LOG=<file> to record each decision (handy for demos and debugging). */
function log(entry) {
  if (process.env.AXOLOTL_HOOK_LOG) appendFileSync(process.env.AXOLOTL_HOOK_LOG, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}

const GIVE_UP =
  /\b(i can(no|')t|i cannot|can(no|')t (add|do|place|complete|order|book|access|find)|could(n'?t| not) (add|do|place|complete|order|book|access|find)|was(n'?t| not) able to|can only (search|read|view|look)|i'?m (not able|unable)|unable to|not able to|doesn'?t support|does not support|only supports?|isn'?t supported|no (tool|way) to|i (have )?overstated|limitation of|requires? a full address|please (provide|share|tell me)|what('| i)s your (delivery )?address|street (number|name)|zip code)\b/i;

function lastAssistantText(payload) {
  if (typeof payload.last_assistant_message === "string") return payload.last_assistant_message;
  const path = payload.transcript_path;
  if (!path) return "";
  const lines = readFileSync(path, "utf8").trim().split("\n");
  for (let i = lines.length - 1; i >= 0 && i >= lines.length - 200; i--) {
    let row;
    try {
      row = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    // Claude Code: {type:"assistant", message:{content:[{type:"text",text}]}}
    // Codex: {type:"response_item", payload:{type:"message", role:"assistant", content:[{type:"output_text",text}]}}
    const msg = row.type === "assistant" ? row.message : row.payload?.role === "assistant" ? row.payload : row.role === "assistant" ? row : null;
    if (!msg) continue;
    const content = Array.isArray(msg.content) ? msg.content : [{ text: msg.content }];
    const text = content.map((c) => (typeof c?.text === "string" ? c.text : "")).join("\n").trim();
    if (text) return text;
  }
  return "";
}

try {
  const payload = JSON.parse(readFileSync(0, "utf8") || "{}");
  // Already continued once because of this hook: let it stop, so it can never loop.
  if (payload.stop_hook_active) {
    log({ decision: "allow", why: "already continued once" });
    process.exit(0);
  }
  const text = lastAssistantText(payload).slice(-4000);
  const m = GIVE_UP.exec(text);
  if (!m) {
    log({ decision: "allow", why: "no give-up phrase" });
    process.exit(0);
  }
  const reason =
    `Axolotl: your last reply gives up or hands work back to the person ("${m[0]}"). Before stopping, call the axolotl_recover tool ` +
    `with the person's goal and that failure text, then follow its next step (for example axolotl_resolve_place for an address, or axolotl_add_to_cart when a delivery plugin can't add to a cart). ` +
    `If Axolotl can't help either, tell the person plainly what failed and what you tried.`;
  log({ decision: "block", matched: m[0] });
  process.stdout.write(JSON.stringify({ decision: "block", reason }));
} catch {
  process.exit(0);
}
