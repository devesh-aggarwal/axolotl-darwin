// Writes the current rankings to data/rankings.json (see rankingsSnapshot.ts). The server does the
// writing because it owns the database; `npm run rankings:save` calls this.
import path from "node:path";
import { handle, ok } from "@/lib/api";
import { getDb } from "@/lib/db";
import { env } from "@/lib/env";
import { saveRankings, snapshotPath } from "@/lib/engine/rankingsSnapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = handle(async () => ok(saveRankings(getDb(), snapshotPath(path.resolve(process.cwd(), env.dataDir)))));
