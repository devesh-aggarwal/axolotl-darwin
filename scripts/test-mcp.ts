// Axolotl MCP server: protocol, tools and failover. Calls the handler directly (no HTTP server).
// Map lookups use a fake fetch unless --live is passed (then Photon/Nominatim/Darwin are real).
import assert from "node:assert/strict";
import { handleAxolotlMcp } from "@/lib/mcp/server";
import { classify, planRecovery } from "@/lib/mcp/recover";
import { matchSavedPlace, resolvePlace, verifyPlace } from "@/lib/mcp/places";
import { orderFood } from "@/lib/mcp/ordering";

const live = process.argv.includes("--live");
let passed = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

// Fake map sources: both know Castaño; Nominatim has a slightly different postcode, like the real ones.
const fakeFetch = (async (input: string | URL | Request) => {
  const url = String(input);
  const castano = /castano/i.test(decodeURIComponent(url));
  if (url.includes("photon.komoot.io")) {
    const features = castano
      ? [{ properties: { name: "Castaño", housenumber: "685", street: "Escondido Road", city: "Stanford", state: "California", postcode: "94305" }, geometry: { coordinates: [-122.1608265, 37.425045] } }]
      : [];
    return Response.json({ features });
  }
  if (url.includes("nominatim")) {
    const rows = castano
      ? [{ lat: "37.4250450", lon: "-122.1608265", name: "Castaño", address: { house_number: "685", road: "Escondido Road", hamlet: "Stanford", state: "California", postcode: "94304" } }]
      : [];
    return Response.json(rows);
  }
  return new Response("nope", { status: 500 });
}) as typeof fetch;

async function rpc(body: unknown, headers: Record<string, string> = {}) {
  const res = await handleAxolotlMcp(new Request("http://localhost/api/mcp", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { res, json: res.status === 202 ? null : ((await res.json()) as Record<string, any>) };
}

async function main() {
  console.log("protocol");
  await check("initialize returns server info, instructions and a session id", async () => {
    const { res, json } = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    assert.equal(json!.result.serverInfo.name, "axolotl");
    assert.equal(json!.result.protocolVersion, "2025-06-18");
    assert.ok(json!.result.instructions.includes("BEFORE giving up"));
    assert.ok(res.headers.get("mcp-session-id"));
  });
  await check("unknown protocol version falls back to the newest supported", async () => {
    const { json } = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01" } });
    assert.equal(json!.result.protocolVersion, "2025-06-18");
  });
  await check("notifications get 202 and no body", async () => {
    const { res } = await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
    assert.equal(res.status, 202);
  });
  await check("works without a session header (stateless)", async () => {
    const { json } = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const names = json!.result.tools.map((t: { name: string }) => t.name);
    for (const n of ["axolotl_resolve_place", "axolotl_add_to_cart", "axolotl_checkout", "axolotl_recover", "axolotl_find_agents", "axolotl_start_site_audit", "axolotl_get_run"]) assert.ok(names.includes(n), n);
    assert.ok(json!.result.tools.every((t: Record<string, unknown>) => !("call" in t)));
  });
  await check("unknown tool and bad args are reported, not thrown", async () => {
    const a = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "nope", arguments: {} } });
    assert.equal(a.json!.error.code, -32602);
    const b = await rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "axolotl_resolve_place", arguments: {} } });
    assert.equal(b.json!.result.isError, true);
    assert.match(b.json!.result.content[0].text, /"query" is required/);
  });
  await check("parse errors and invalid requests", async () => {
    const res = await handleAxolotlMcp(new Request("http://localhost/api/mcp", { method: "POST", body: "{nope" }));
    assert.equal(res.status, 400);
    const { res: r2 } = await rpc({ hello: 1 });
    assert.equal(r2.status, 400);
  });
  await check("token required when AXOLOTL_MCP_TOKEN is set (header or ?key=)", async () => {
    process.env.AXOLOTL_MCP_TOKEN = "s3cret";
    try {
      assert.equal((await rpc({ jsonrpc: "2.0", id: 5, method: "ping" })).res.status, 401);
      assert.equal((await rpc({ jsonrpc: "2.0", id: 5, method: "ping" }, { authorization: "Bearer s3cret" })).res.status, 200);
      const viaKey = await handleAxolotlMcp(new Request("http://localhost/api/mcp?key=s3cret", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 6, method: "ping" }) }));
      assert.equal(viaKey.status, 200);
    } finally {
      delete process.env.AXOLOTL_MCP_TOKEN;
    }
  });

  console.log("recovery triage (the ChatGPT transcript)");
  await check("asking for a street address = needs_input", () => {
    assert.equal(classify("Please provide Castaño's street number and street name in Stanford. The Uber Eats plugin requires a full address to search."), "needs_input");
  });
  await check("search-only plugin = capability_missing", () => {
    assert.equal(classify("The Uber Eats plugin only exposes search_uber_eats; it has no add-to-cart tool, so I couldn't add the crepe."), "capability_missing");
    assert.equal(classify("Correct, the Uber Eats plugin available here can search restaurants and food, but can't add items to your cart. I overstated what I could do earlier."), "capability_missing");
  });
  await check("needs_input picks the delivery place, not 'my cart'", async () => {
    const plan = await planRecovery("Add a crepe from a bakery to my Uber Eats cart. Deliver to the a16z Sansome St office.", "A full delivery address is required: street number, street name.");
    assert.equal(plan.useTool?.arguments.query, "a16z Sansome St office");
  });
  await check("timeouts and logins are told apart", () => {
    assert.equal(classify("Request timed out after 30s"), "transient");
    assert.equal(classify("Please sign in to continue"), "auth_or_payment");
  });

  console.log(`places (${live ? "live" : "fake"} map sources)`);
  const f = live ? fetch : fakeFetch;
  await check("castano stanford resolves to 685 Escondido Road, confirmed by a second source", async () => {
    const r = await resolvePlace("castano stanford", { fetchImpl: f });
    assert.equal(r.status, "resolved");
    assert.equal(r.place!.houseNumber, "685");
    assert.match(r.place!.street!, /Escondido/);
    assert.equal(r.confidence, "confirmed");
    assert.equal(r.attempts[0].source, "public-api", "free sources go first");
    assert.ok(!r.attempts.some((a) => a.source === "darwin"), "Darwin backup not needed when free sources agree");
  });
  await check("unknown place is not_found, nothing invented; Darwin backup tried last", async () => {
    const r = await resolvePlace("zzqxv nowhere building 9", { fetchImpl: f });
    assert.equal(r.status, "not_found");
    assert.equal(r.place, null);
    assert.equal(r.attempts.at(-1)!.source, "darwin");
  });

  await check("street-only match can't pass for a named place; house numbers must match", () => {
    const one = { name: "One Sansome Street", houseNumber: "1", street: "Sansome Street", city: "San Francisco", postcode: "94104", lat: 0, lon: 0, address: "1 Sansome Street, San Francisco, CA 94104", source: "Photon" };
    assert.match(verifyPlace("a16z sansome st")([{ ...one }])!, /nothing called "a16z"/);
    assert.match(verifyPlace("1025 sansome st san francisco")([{ ...one }])!, /ignored the house number/);
    assert.equal(verifyPlace("1 sansome st san francisco")([{ ...one }]), null);
  });
  await check("saved places match by alias, ignoring filler words", () => {
    const saved = [{ label: "a16z Sansome St office", aliases: ["a16z office"], address: "1025 Sansome St, San Francisco, CA" }];
    assert.equal(matchSavedPlace("the a16z Sansome St office", saved)?.address, "1025 Sansome St, San Francisco, CA");
    assert.equal(matchSavedPlace("sansome st", saved), null, "a street alone doesn't match a saved place");
    assert.equal(matchSavedPlace("castano stanford", saved), null);
  });

  console.log("ordering (simulated platforms)");
  await check("crepe from a Palo Alto bakery: Uber Eats skipped (no cart tool), DoorDash builds a verified cart", async () => {
    const r = await orderFood({ item: "crepe", restaurantHint: "bakery", area: "Palo Alto", deliverTo: "castano stanford" }, { fetchImpl: f });
    assert.equal(r.status, "awaiting_confirmation");
    assert.equal(r.cart!.platform, "DoorDash agent");
    assert.match(r.cart!.deliverTo, /685 Escondido/);
    assert.equal(r.cart!.restaurantCity, "Palo Alto");
    assert.equal(r.cart!.restaurant, "Emerson Street Bakehouse", "the bakery hint picks a bakery");
    const uber = r.attempts.find((a) => a.agent === "Uber Eats plugin");
    assert.equal(uber?.outcome, "skipped");
    assert.match(uber!.reason, /no add-to-cart/);
  });
  await check("silent failure (agent uses the saved address) is caught and swapped to Grubhub", async () => {
    const r = await orderFood({ item: "crepe", area: "Palo Alto", deliverTo: "castano stanford", demoFault: "wrong_address" }, { fetchImpl: f });
    assert.equal(r.cart!.platform, "Grubhub agent");
    const dd = r.attempts.find((a) => a.agent === "DoorDash agent");
    assert.equal(dd?.outcome, "rejected");
    assert.match(dd!.reason, /Hacker Way/);
  });
  await check("budget cap rejects every cart -> unfulfilled, nothing ordered", async () => {
    const r = await orderFood({ item: "crepe", area: "Palo Alto", deliverTo: "castano stanford", maxTotalUsd: 5 }, { fetchImpl: f });
    assert.equal(r.status, "unfulfilled");
    assert.equal(r.cart, null);
  });
  await check("unresolvable address stops before any cart", async () => {
    const r = await orderFood({ item: "crepe", deliverTo: "zzqxv nowhere" }, { fetchImpl: f });
    assert.equal(r.status, "address_unresolved");
  });

  console.log(`\n${passed} checks passed${process.exitCode ? ", some FAILED" : ""}`);
}

main();
