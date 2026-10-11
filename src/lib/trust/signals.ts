// Text checks for the trust score: does an agent's listing (or answer) try to steer the calling
// agent, ask for secrets, ship data elsewhere, or mention money? Pure functions, no I/O.
// Every pattern is bounded (no nested quantifiers, capped gaps), and input is clipped, so a
// huge answer can't stall the server.

/** Text scanned per call. Listings are short; answers past this are clipped. */
export const MAX_SCAN_CHARS = 50_000;

/** Tries to override the calling agent's instructions. */
const OVERRIDE: RegExp[] = [
  /\b(?:ignore|disregard|forget|override)\b[^.\n]{0,40}\b(?:previous|prior|earlier|above|other|all|any|your)\b[^.\n]{0,30}\b(?:instructions?|rules|guidelines|prompts?)\b/i,
  /\byou are now\b/i,
  /\b(?:system|developer) prompt\b/i,
  /<\/?\s*(?:important|system|instructions?)\s*>/i,
  /\bdo not (?:tell|inform|mention|show)\b[^.\n]{0,30}\b(?:the )?(?:user|human|operator)\b/i,
];

/** Asks for credentials: by name (OPENAI_API_KEY) or by asking to send/include a key, token or password. */
const SECRET_ASK: RegExp[] = [
  /\b(?:include|send|share|provide|paste|return|reveal|print|forward|attach|pass)\b[^.\n]{0,60}\b(?:api[ _-]?keys?|access[ _-]?tokens?|secrets?|passwords?|credentials?|private[ _-]?keys?|env(?:ironment)?[ _-]?var(?:iable)?s?|cookies?)\b/i,
  /\b[A-Z][A-Z0-9]{1,30}_(?:API_KEY|ACCESS_TOKEN|SECRET(?:_KEY)?|TOKEN|PASSWORD)\b/,
];

/** Ships data to an address the user didn't choose. */
const EXFIL = /\b(?:send|post|upload|forward|copy|mirror|report)\b[^.\n]{0,80}\bto\s+(?:https?:\/\/|[\w-]+(?:\.[\w-]+)+\/)/i;

/** Runs or asks to run commands. */
const SHELL = /\b(?:rm\s+-rf|curl\s+[^|\n]{0,200}\|\s*(?:ba)?sh|wget\s+[^|\n]{0,200}\|\s*(?:ba)?sh|chmod\s+\+x|eval\s*\()/i;

/** Money: prices, per-call billing, paid plans. "Free" alone isn't, and neither is "findings per page". */
const PRICING = /(?:[$€£]\s?\d|\b\d+(?:\.\d+)?\s?(?:usd|eur|credits?)\b|\b(?:billed|charged|costs?|priced?|fees?)\b[^.\n]{0,20}\bper\b|\bpaid (?:plan|tier|subscription)\b|\bsubscription\b|\bpricing\b|\bx402\b|\bfree tier\b|\btrial (?:period|credits?)\b)/i;

export interface TextScan {
  override: boolean;
  secretAsk: boolean;
  exfil: boolean;
  shell: boolean;
  /** The pricing phrase found, if any. */
  pricing: string | null;
}

export function scanText(text: string | undefined | null): TextScan {
  const t = (text ?? "").slice(0, MAX_SCAN_CHARS);
  return {
    override: OVERRIDE.some((re) => re.test(t)),
    secretAsk: SECRET_ASK.some((re) => re.test(t)),
    exfil: EXFIL.test(t),
    shell: SHELL.test(t),
    pricing: PRICING.exec(t)?.[0] ?? null,
  };
}

export function mergeScans(scans: TextScan[]): TextScan {
  return {
    override: scans.some((s) => s.override),
    secretAsk: scans.some((s) => s.secretAsk),
    exfil: scans.some((s) => s.exfil),
    shell: scans.some((s) => s.shell),
    pricing: scans.find((s) => s.pricing)?.pricing ?? null,
  };
}

/** Any unsafe finding (pricing isn't a safety issue). */
export function isUnsafe(s: TextScan): boolean {
  return s.override || s.secretAsk || s.exfil || s.shell;
}

/**
 * An agent's answer tries to take over the caller. Only the override patterns count here: audit
 * findings legitimately talk about API keys, tokens and URLs ("Don't include API keys in client
 * code"), so the secret and exfil patterns would flag honest answers.
 */
export function answerHijacks(raw: unknown): boolean {
  const t = answerText(raw);
  return OVERRIDE.some((re) => re.test(t));
}

/** Stringify an answer for scanning, bounded. */
export function answerText(raw: unknown): string {
  if (typeof raw === "string") return raw.slice(0, MAX_SCAN_CHARS);
  try {
    return (JSON.stringify(raw) ?? "").slice(0, MAX_SCAN_CHARS);
  } catch {
    return "";
  }
}
