// Place resolution: turn "castano stanford" into a full street address without asking the person.
// Providers, cheapest reliable first (same tier order as engine routing: free, then paid, then simulated):
// Photon (komoot) and OpenStreetMap Nominatim are free; a Darwin address agent is the backup and runs only
// with Act access. The first verified answer wins; a second source is asked to confirm it.
import fs from "node:fs";
import path from "node:path";
import { actConfigured, getDarwinClient } from "@/lib/engine/clients";
import { env } from "@/lib/env";
import { routeAgents } from "@/lib/mcp/agents";
import { failover, type Attempt, type Provider } from "@/lib/mcp/failover";

export interface Place {
  name?: string;
  houseNumber?: string;
  street?: string;
  city?: string;
  state?: string;
  postcode?: string;
  country?: string;
  lat: number;
  lon: number;
  /** One-line postal address. */
  address: string;
  source: string;
}

export interface PlaceResolution {
  status: "resolved" | "ambiguous" | "not_found";
  place: Place | null;
  /** "confirmed": a second independent source agrees within 300 m. */
  confidence: "confirmed" | "single_source" | "none";
  confirmation?: string;
  alternatives: Place[];
  attempts: Attempt[];
}

const UA = "Axolotl/0.1 (SpeedHacks hackathon; self-healing agent workflows)";
type Fetch = typeof fetch;

function formatAddress(p: Omit<Place, "address" | "source" | "lat" | "lon">): string {
  const line1 = [p.houseNumber, p.street].filter(Boolean).join(" ");
  const region = [p.state, p.postcode].filter(Boolean).join(" ");
  return [line1, p.city, region].filter(Boolean).join(", ");
}

const STATE_ABBR: Record<string, string> = { California: "CA", "New York": "NY", Texas: "TX", Washington: "WA", Massachusetts: "MA" };

async function getJson(fetchImpl: Fetch, url: string, signal: AbortSignal): Promise<unknown> {
  const res = await fetchImpl(url, { headers: { "user-agent": UA, accept: "application/json" }, signal, redirect: "error" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function photonProvider(query: string, fetchImpl: Fetch = fetch): Provider<Place[]> {
  return {
    name: "Photon geocoder (komoot, OpenStreetMap)",
    source: "public-api",
    run: async (signal) => {
      const body = (await getJson(fetchImpl, `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=5&lang=en`, signal)) as {
        features?: { properties?: Record<string, string>; geometry?: { coordinates?: [number, number] } }[];
      };
      return (body.features ?? []).flatMap((f) => {
        const p = f.properties ?? {};
        const c = f.geometry?.coordinates;
        if (!c) return [];
        const parts = { name: p.name, houseNumber: p.housenumber, street: p.street, city: p.city ?? p.district, state: STATE_ABBR[p.state] ?? p.state, postcode: p.postcode, country: p.country };
        return [{ ...parts, lat: c[1], lon: c[0], address: formatAddress(parts), source: "Photon" }];
      });
    },
  };
}

export function nominatimProvider(query: string, fetchImpl: Fetch = fetch): Provider<Place[]> {
  return {
    name: "OpenStreetMap Nominatim",
    source: "public-api",
    run: async (signal) => {
      const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=jsonv2&limit=5&addressdetails=1`;
      const body = (await getJson(fetchImpl, url, signal)) as { lat: string; lon: string; name?: string; address?: Record<string, string> }[];
      return (Array.isArray(body) ? body : []).map((r) => {
        const a = r.address ?? {};
        const parts = {
          name: r.name || undefined,
          houseNumber: a.house_number,
          street: a.road,
          city: a.city ?? a.town ?? a.village ?? a.hamlet ?? a.suburb,
          state: STATE_ABBR[a.state] ?? a.state,
          postcode: a.postcode,
          country: a.country,
        };
        return { ...parts, lat: Number(r.lat), lon: Number(r.lon), address: formatAddress(parts), source: "Nominatim" };
      });
    },
  };
}

const ADDRESS_QUERY = "find the street address of a business or place by name";

/** A Darwin agent that finds business addresses. Runs only with Act access; otherwise skipped, with the reason. */
export function darwinPlaceProvider(query: string): Provider<Place[]> {
  let agentName = "Darwin address agent";
  return {
    name: agentName,
    source: "darwin",
    precheck: async () => {
      if (!actConfigured()) return "Darwin Act access isn't granted yet (pilot allowlist), so no Darwin agent can run unattended";
      const r = await routeAgents(ADDRESS_QUERY).catch(() => null);
      const top = r?.runnable[0];
      if (!top) return r?.skipped[0] ? `Darwin's address agents can't run unattended (${r.skipped[0].reason.toLowerCase()})` : "Darwin search found no address agent right now";
      agentName = top.agent.name;
      return null;
    },
    run: async () => {
      // Act runs are polled through the shared client; parse the first US-style street address in the answer.
      const client = getDarwinClient("darwin");
      const r = await routeAgents(ADDRESS_QUERY);
      const agent = r.runnable[0]?.candidate;
      if (!agent) throw new Error("no runnable Darwin address agent");
      const handle = await client.startTask({
        agent,
        instruction: `What is the full street address of "${query}"? Answer with the address only.`,
        idempotencyKey: `place-${Date.now()}`,
        searchId: r.searchId,
        context: { runId: "mcp", nodeInstanceId: "resolve_place", capability: "crawl", input: { siteUrl: "", maxPages: 1 }, seed: 0, attemptNo: 1, timeScale: 1 },
      });
      for (let i = 0; i < 20; i++) {
        const poll = await client.pollTask(handle);
        if (poll.status === "completed") {
          const text = typeof poll.output === "string" ? poll.output : JSON.stringify(poll.output);
          const m = /(\d{1,6})\s+([A-Z][\w .'-]+?),\s*([A-Z][\w .'-]+?),\s*([A-Z]{2})\s*(\d{5})?/.exec(text);
          if (!m) return [];
          const parts = { houseNumber: m[1], street: m[2], city: m[3], state: m[4], postcode: m[5] };
          return [{ ...parts, lat: NaN, lon: NaN, address: formatAddress(parts), source: agent.name }];
        }
        if (poll.status === "error") throw new Error(poll.message);
        if (poll.status === "blocked") throw new Error(`${poll.kind} required: ${poll.message}`);
        await new Promise((r) => setTimeout(r, 1000));
      }
      throw new Error("no answer after 20 polls");
    },
  };
}

const STREET_WORDS = new Set(["st", "street", "rd", "road", "ave", "avenue", "blvd", "boulevard", "dr", "drive", "way", "ln", "lane", "ct", "court", "pl", "place", "hwy"]);
const GENERIC = new Set(["the", "a", "an", "at", "in", "near", "my", "our", "office", "offices", "building", "hq", "headquarters", "campus", "house", "home", "dorm", "ca", "usa", "us", "california", "location", "place", "work", "deliver", "delivery", "to", "for"]);

/** "my location at Salesforce Tower" → "Salesforce Tower". */
export function stripFiller(query: string): string {
  return query.replace(/^\s*(please\s+)?(deliver(y)?\s+to\s+)?(my|our|the)\s+(current\s+)?(location|office|place|spot|desk|building)\s+(at|in|on)\s+/i, "").replace(/^\s*(at|to)\s+/i, "").trim() || query.trim();
}

/** Street names the person said ("sansome" in "a16z sansome st"); a looked-up address must be on one of them. */
function namedStreets(query: string): string[] {
  const w = words(query);
  return w.filter((t, i) => STREET_WORDS.has(w[i + 1] ?? "") && !/^\d/.test(t));
}

export function foldText(s?: string): string {
  return (s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}
function words(s?: string): string[] {
  return foldText(s).split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * Deliverable means a street, a house number, and a city or postcode. It must also be the place that was
 * asked for: a house number in the request must match, and a name in it ("a16z", "castano") must appear
 * somewhere in the answer, so "One Sansome Street" can't pass for "a16z sansome st".
 */
export function verifyPlace(query: string) {
  const q = words(query);
  const wantNumber = q.find((w) => /^\d+[a-z]?$/.test(w));
  const distinctive = q.filter((w) => !/^\d+$/.test(w) && !STREET_WORDS.has(w) && !GENERIC.has(w));
  return (places: Place[]): string | null => {
    if (places.length === 0) return "no match for that name";
    const problems: string[] = [];
    for (const p of places) {
      const missing = [!p.houseNumber && "house number", !p.street && "street", !p.city && !p.postcode && "city or ZIP"].filter(Boolean);
      if (missing.length) {
        problems.push(`"${p.name ?? p.address}" has no ${missing.join(", ")}`);
        continue;
      }
      if (wantNumber && foldText(p.houseNumber) !== wantNumber) {
        problems.push(`ignored the house number (gave ${p.address}); answer discarded`);
        continue;
      }
      const have = new Set(words(`${p.name ?? ""} ${p.street} ${p.city ?? ""} ${p.state ?? ""} ${p.postcode ?? ""}`));
      const unmatched = distinctive.filter((w) => !have.has(w));
      // Every distinctive word must be accounted for (city and street words count).
      if (unmatched.length) {
        problems.push(`returned ${p.name && !p.address.includes(p.name) ? `${p.name}, ` : ""}${p.address}, which has nothing called "${unmatched.join(" ")}"`);
        continue;
      }
      // Put the verified match first so callers use it.
      if (p !== places[0]) {
        places.splice(places.indexOf(p), 1);
        places.unshift(p);
      }
      return null;
    }
    return problems[0];
  };
}

/** Kept for callers that only need the deliverable check. */
export function verifyDeliverable(places: Place[]): string | null {
  return verifyPlace("")(places);
}

// ---------- saved places (the person's own address book, like a delivery app's saved addresses) ----------

export interface SavedPlace {
  label: string;
  aliases: string[];
  address: string;
}

export function loadSavedPlaces(): SavedPlace[] {
  try {
    const file = path.join(process.cwd(), env.dataDir, "saved-places.json");
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter((r): r is SavedPlace => Boolean(r && typeof r.label === "string" && typeof r.address === "string" && Array.isArray(r.aliases)));
  } catch {
    return [];
  }
}

/** A saved place matches when all of its alias's meaningful words appear in the request. */
export function matchSavedPlace(query: string, saved: SavedPlace[]): SavedPlace | null {
  const q = new Set(words(query).filter((w) => !GENERIC.has(w)));
  let best: { place: SavedPlace; score: number } | null = null;
  for (const place of saved) {
    for (const alias of [place.label, ...place.aliases]) {
      const a = words(alias).filter((w) => !GENERIC.has(w));
      if (a.length === 0 || !a.every((w) => q.has(w))) continue;
      if (!best || a.length > best.score) best = { place, score: a.length };
    }
  }
  return best?.place ?? null;
}

export function distanceMeters(a: Place, b: Place): number {
  if (![a.lat, a.lon, b.lat, b.lon].every(Number.isFinite)) return Infinity;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

function sameStreetAddress(a: Place, b: Place): boolean {
  const norm = (s?: string) => (s ?? "").toLowerCase().replace(/\b(road|rd|street|st|avenue|ave|drive|dr|way|lane|ln)\b\.?/g, "").replace(/\W/g, "");
  return Boolean(a.houseNumber) && a.houseNumber === b.houseNumber && norm(a.street) === norm(b.street);
}

/** A passing lookup, in words: "found 685 Escondido Road, Stanford, CA 94305". */
const foundNote = (places: Place[]) => `found ${places[0].address}`;

export async function resolvePlace(
  query: string,
  opts: { near?: string; fetchImpl?: Fetch; savedPlaces?: SavedPlace[]; addressHint?: string } = {},
): Promise<PlaceResolution> {
  const attempts: Attempt[] = [];
  query = stripFiller(query);
  // The host found a street address on the web: check it exists on the map and fits what the person said.
  if (opts.addressHint?.trim()) return resolveHint(query, opts.addressHint.trim(), opts.fetchImpl ?? fetch);
  // The person's own saved places come first: free, instant, and exactly what they mean.
  const saved = matchSavedPlace(query, opts.savedPlaces ?? loadSavedPlaces());
  if (saved) {
    attempts.push({ step: "resolve address", agent: "Your saved places", source: "public-api", outcome: "ok", reason: `"${query}" is saved as ${saved.label}: ${saved.address}`, ms: 0 });
  }
  const q = saved ? saved.address : [query.trim(), opts.near?.trim()].filter(Boolean).join(", ");
  const f = opts.fetchImpl ?? fetch;
  const chain = [photonProvider(q, f), nominatimProvider(q, f), darwinPlaceProvider(q)];
  const result = await failover(saved ? "locate saved address" : "resolve address", chain, verifyPlace(q), { describe: foundNote });
  attempts.push(...result.attempts);
  if (!result.value || !result.provider) {
    return { status: "not_found", place: null, confidence: "none", alternatives: [], attempts };
  }
  const [place, ...rest] = result.value;
  // A saved address the map confirms is two independent sources: the person and the map.
  if (saved) {
    place.name = saved.label;
    return { status: "resolved", place, confidence: "confirmed", confirmation: `your saved address, located by ${result.provider.name}`, alternatives: [], attempts };
  }

  // Cross-check with the next public source that hasn't answered yet.
  let confidence: PlaceResolution["confidence"] = "single_source";
  let confirmation: string | undefined;
  const others = chain.slice(chain.indexOf(result.provider) + 1).filter((p) => p.source === "public-api");
  for (const other of others) {
    const check = await failover("cross-check address", [other], (v) => (v.length ? null : "no match"));
    if (check.value) check.value = check.value.filter((p) => !verifyPlace(q)([p]));
    attempts.push(...check.attempts);
    const match = check.value?.find((p) => distanceMeters(p, place) < 300 || sameStreetAddress(p, place));
    if (match) {
      confidence = "confirmed";
      confirmation = `confirmed by two map services, ${result.provider.name.split(" (")[0]} and ${other.name}`;
      attempts[attempts.length - 1] = { ...attempts[attempts.length - 1], reason: `agrees: ${match.address}` };
      if (!place.postcode && match.postcode) place.postcode = match.postcode;
      break;
    }
    if (check.attempts[0]?.outcome === "ok") {
      const top = check.value?.[0];
      attempts[attempts.length - 1] = { ...attempts[attempts.length - 1], outcome: "rejected", reason: top ? `disagrees: top match is ${top.address}` : "has no match that fits the request" };
    }
  }

  // Several deliverable matches far apart = ambiguous; hand the choice back instead of guessing.
  const far = rest.filter((p) => p.houseNumber && p.street && distanceMeters(p, place) > 2_000);
  const status = far.length > 0 && confidence !== "confirmed" ? "ambiguous" : "resolved";
  return { status, place, confidence, confirmation, alternatives: far.slice(0, 3), attempts };
}

async function resolveHint(query: string, hint: string, f: Fetch): Promise<PlaceResolution> {
  const attempts: Attempt[] = [{ step: "resolve address", agent: "Web search (run by you)", source: "public-api", outcome: "ok", reason: `suggested ${hint} for "${query}"`, ms: 0 }];
  const streets = namedStreets(query);
  const result = await failover("check web result on the map", [nominatimProvider(hint, f), photonProvider(hint, f)], (places) => {
    const base = verifyPlace(hint)(places);
    if (base) return base;
    const street = foldText(places[0].street);
    if (streets.length && !streets.some((st) => street.includes(st))) return `${places[0].address} isn't on ${streets.join(" or ")}, which is where the person said`;
    return null;
  }, { describe: foundNote });
  attempts.push(...result.attempts);
  if (!result.value) return { status: "not_found", place: null, confidence: "none", alternatives: [], attempts };
  const place = { ...result.value[0], name: query };
  return { status: "resolved", place, confidence: "confirmed", confirmation: `a web search found it and ${result.provider!.name} confirmed the address exists`, alternatives: [], attempts };
}
