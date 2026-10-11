import { handle, ok } from "@/lib/api";
import { getLlmUsage } from "@/lib/llm/gateway";

export const runtime = "nodejs";

/** Usage counters only; never makes a call. */
export const GET = handle(async () => ok({ llm: getLlmUsage() }));
