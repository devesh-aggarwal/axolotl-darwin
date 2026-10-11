import { body, handle, ok } from "@/lib/api";
import { cancelTimelapse, getTimelapse, startTimelapse, type TimelapseOptions } from "@/lib/engine/timelapse";

export const runtime = "nodejs";

export const GET = handle(async () => {
  const s = getTimelapse();
  return ok({ timelapse: s ? { id: s.id, running: s.running, ticks: s.ticks, options: s.options } : null });
});

export const POST = handle(async (req: Request) => {
  const s = startTimelapse(await body<TimelapseOptions>(req));
  return ok({ timelapse: { id: s.id, running: s.running, ticks: s.ticks, options: s.options } });
});

export const DELETE = handle(async () => ok({ cancelled: cancelTimelapse() }));
