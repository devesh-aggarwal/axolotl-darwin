// SIMULATED Uber Eats plugin (search only, needs a full street address), for the with/without demo.
import { handleMcp } from "@/lib/mcp/server";
import { UBER_EATS_SIM } from "@/lib/mcp/uberEatsSim";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const serve = (req: Request) => handleMcp(UBER_EATS_SIM, req);

export const POST = serve;
export const GET = serve;
export const DELETE = serve;
