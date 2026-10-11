// Local test agents over MCP (Streamable HTTP), for trying direct connections without Darwin.
// They only audit the demo site served by this app.
import { handle } from "@/lib/api";
import { isWithinSite, siteRootUrl } from "@/lib/audit/url";
import { demoSiteUrl } from "@/lib/env";
import { handleMcpRequest } from "@/lib/testAgents/mcpServer";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ agent: string }> };

const allowSite = (url: string) => isWithinSite(url, siteRootUrl(demoSiteUrl()));

const serve = handle(async (req: Request, ctx: Ctx) => {
  const { agent } = await ctx.params;
  return handleMcpRequest(req, agent, { allowSite });
});

export const POST = serve;
export const DELETE = serve;
export const GET = serve;
