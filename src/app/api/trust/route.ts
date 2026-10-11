// Trust reports for every agent Axolotl has found: safety, cost and quality, updated by trials and runs.
// The record Axolotl keeps of which agents actually deliver, ready to share with users later.
import { fail, handle, ok } from "@/lib/api";
import { allTrustReports } from "@/lib/trust/store";
import { CAPABILITIES, type Capability } from "@/lib/types";

export const runtime = "nodejs";

export const GET = handle(async (req: Request) => {
  const cap = new URL(req.url).searchParams.get("capability");
  if (cap && !CAPABILITIES.includes(cap as Capability)) return fail(400, "Unknown capability");
  return ok({ reports: allTrustReports((cap as Capability | null) ?? undefined) });
});
