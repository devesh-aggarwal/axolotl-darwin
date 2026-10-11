import { productMode } from "@/config/mode";
import { AGENT_TEMPLATES, DEFAULTS, WORKFLOW } from "@/config/workflow";
import { handle, ok } from "@/lib/api";
import { actConfigured } from "@/lib/engine/clients";
import { defaultRunConfig, getActiveRunId, getChaos, recentRuns } from "@/lib/engine/runtime";
import { getAllStats } from "@/lib/engine/stats";
import { getTimelapse } from "@/lib/engine/timelapse";
import { getLlmUsage } from "@/lib/llm/gateway";

export const runtime = "nodejs";

export const GET = handle(async () => {
  const tl = getTimelapse();
  return ok({
    mode: productMode(),
    workflow: WORKFLOW,
    agentTemplates: AGENT_TEMPLATES.map((t) => t.id),
    defaults: { ...defaultRunConfig(), manualAuditHours: DEFAULTS.manualAuditHours, llmCallsPerRun: DEFAULTS.llmCallsPerRun },
    chaos: getChaos(),
    activeRunId: getActiveRunId(),
    runs: recentRuns(15),
    stats: getAllStats(),
    llm: getLlmUsage(),
    darwin: { actConfigured: actConfigured() },
    timelapse: tl ? { id: tl.id, running: tl.running, ticks: tl.ticks, options: tl.options } : null,
  });
});
