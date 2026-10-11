// Axolotl's own MCP server: connect ChatGPT, Codex or Claude Code to <base>/api/mcp.
// Not wrapped in handle(): MCP hosts call server-to-server, and the endpoint has its own optional token.
import { handleAxolotlMcp } from "@/lib/mcp/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function serve(req: Request): Promise<Response> {
  try {
    return await handleAxolotlMcp(req);
  } catch (err) {
    console.error("[mcp]", (err as Error)?.message);
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal error" } }, { status: 500 });
  }
}

export const POST = serve;
export const GET = serve;
export const DELETE = serve;
