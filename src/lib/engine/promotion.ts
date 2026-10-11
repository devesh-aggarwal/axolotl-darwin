// Promotion rule shared by the engine (pools.ts) and the leaderboard UI. No server imports.

/** A backup is promoted over the primary once it is this much more reliable... */
export const PROMOTE_MARGIN = 0.08;
/** ...and both have at least this many observed attempts. */
export const PROMOTE_MIN_ATTEMPTS = 8;

export function shouldPromote(
  primary: { score: number; attempts: number } | undefined,
  backup: { score: number; attempts: number } | undefined,
): boolean {
  if (!primary || !backup) return false;
  if (primary.attempts < PROMOTE_MIN_ATTEMPTS || backup.attempts < PROMOTE_MIN_ATTEMPTS) return false;
  return backup.score - primary.score >= PROMOTE_MARGIN;
}
