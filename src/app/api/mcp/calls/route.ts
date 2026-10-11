// Recent MCP tool calls and their failover traces, newest first.
import { handle, ok } from "@/lib/api";
import { mcpCallLog } from "@/lib/mcp/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handle(async () => ok({ calls: mcpCallLog() }));
