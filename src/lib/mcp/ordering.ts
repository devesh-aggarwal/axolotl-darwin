// Food ordering with failover across delivery agents. Darwin's delivery agents are listed first and
// run when Act access exists; until then the delivery platforms below are SIMULATED (fictional
// restaurants, no real cart, nothing charged), and every answer says so. Address resolution is real.
import { randomUUID } from "node:crypto";
import { actConfigured } from "@/lib/engine/clients";
import { findAgents } from "@/lib/mcp/agents";
import { BlockedError, failover, type Attempt, type Provider } from "@/lib/mcp/failover";
import { resolvePlace, type Place, type PlaceResolution } from "@/lib/mcp/places";

export interface MenuItem {
  name: string;
  priceUsd: number;
}

interface Restaurant {
  name: string;
  city: string;
  kinds: string[];
  menu: MenuItem[];
}

/** Fictional catalog shared by the simulated platforms. */
const CATALOG: Restaurant[] = [
  {
    name: "Ramona Street Crêperie",
    city: "Palo Alto",
    kinds: ["creperie", "dessert", "cafe"],
    menu: [
      { name: "Nutella Banana Crêpe", priceUsd: 12.5 },
      { name: "Strawberry & Cream Crêpe", priceUsd: 11.75 },
      { name: "Ham & Gruyère Crêpe", priceUsd: 14 },
    ],
  },
  {
    name: "Emerson Street Bakehouse",
    city: "Palo Alto",
    kinds: ["bakery", "cafe"],
    menu: [
      { name: "Almond Crêpe", priceUsd: 10.95 },
      { name: "Butter Croissant", priceUsd: 4.5 },
      { name: "Morning Bun", priceUsd: 5.25 },
    ],
  },
  {
    name: "California Ave Pizza Co.",
    city: "Palo Alto",
    kinds: ["pizza", "italian"],
    menu: [
      { name: "Margherita Pizza", priceUsd: 18 },
      { name: "Pepperoni Pizza", priceUsd: 20 },
    ],
  },
  {
    name: "Lytton Noodle House",
    city: "Palo Alto",
    kinds: ["thai", "noodles"],
    menu: [
      { name: "Pad Thai", priceUsd: 16.5 },
      { name: "Drunken Noodles", priceUsd: 17 },
    ],
  },
  {
    name: "Jackson Square Crêperie",
    city: "San Francisco",
    kinds: ["creperie", "dessert", "cafe"],
    menu: [
      { name: "Nutella Strawberry Crêpe", priceUsd: 13.5 },
      { name: "Smoked Salmon Crêpe", priceUsd: 16 },
    ],
  },
  {
    name: "Battery Street Bakery",
    city: "San Francisco",
    kinds: ["bakery", "cafe"],
    menu: [
      { name: "Lemon Sugar Crêpe", priceUsd: 9.75 },
      { name: "Almond Croissant", priceUsd: 5.5 },
    ],
  },
  {
    name: "Castro Street Crêpes",
    city: "Mountain View",
    kinds: ["creperie", "dessert"],
    menu: [{ name: "Classic Sugar Crêpe", priceUsd: 9.5 }],
  },
];

export interface Cart {
  cartId: string;
  platform: string;
  restaurant: string;
  restaurantCity: string;
  items: { name: string; quantity: number; priceUsd: number }[];
  subtotalUsd: number;
  deliveryFeeUsd: number;
  totalUsd: number;
  deliverTo: string;
  status: "in_cart" | "placed";
  simulated: true;
}

export type DemoFault = "none" | "wrong_address" | "timeout";

export interface OrderRequest {
  item: string;
  restaurantHint?: string;
  area?: string;
  deliverTo: string;
  quantity?: number;
  maxTotalUsd?: number;
  demoFault?: DemoFault;
}

export interface OrderResult {
  status: "awaiting_confirmation" | "address_unresolved" | "address_ambiguous" | "unfulfilled";
  cart: Cart | null;
  address: PlaceResolution;
  attempts: Attempt[];
  needsFromYou?: string;
}

const g = globalThis as unknown as { __axolotlCarts?: Map<string, Cart> };
function carts(): Map<string, Cart> {
  g.__axolotlCarts ??= new Map();
  return g.__axolotlCarts;
}

export function fold(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

const STOP = new Set(["a", "an", "the", "some", "from", "of", "with", "and", "to", "me", "my", "please", "one", "order"]);
export function tokens(s: string): string[] {
  return fold(s)
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !STOP.has(t))
    .map((t) => (t.length > 3 && t.endsWith("s") ? t.slice(0, -1) : t));
}

function itemMatches(requested: string, offered: string): boolean {
  const want = tokens(requested);
  const have = new Set(tokens(offered));
  return want.length > 0 && want.some((t) => have.has(t));
}

function pick(req: OrderRequest, area: string): { restaurant: Restaurant; item: MenuItem } | null {
  const hint = req.restaurantHint ? tokens(req.restaurantHint) : [];
  const options = CATALOG.filter((r) => !area || fold(r.city) === fold(area)).flatMap((r) =>
    r.menu.filter((m) => itemMatches(req.item, m.name)).map((item) => ({ restaurant: r, item, hinted: hint.some((h) => r.kinds.includes(h) || tokens(r.name).includes(h)) })),
  );
  options.sort((a, b) => Number(b.hinted) - Number(a.hinted));
  return options[0] ?? null;
}

/** Catalog search for the simulated Uber Eats plugin: dishes matching the query, nearest city first. */
export function searchCatalog(query: string, address: string): { item: string; priceUsd: number; restaurant: string; city: string }[] {
  const a = fold(address);
  return CATALOG.flatMap((r) => r.menu.filter((m) => itemMatches(query, m.name)).map((m) => ({ item: m.name, priceUsd: m.priceUsd, restaurant: r.name, city: r.city })))
    .sort((x, y) => Number(a.includes(fold(y.city))) - Number(a.includes(fold(x.city))))
    .slice(0, 6);
}

interface Platform {
  name: string;
  tools: string[];
  feeUsd: number;
}

const PLATFORMS: Platform[] = [
  // Mirrors the real Uber Eats plugin seen in ChatGPT: search and menus only, no cart.
  { name: "Uber Eats plugin", tools: ["search_restaurants", "get_menu"], feeUsd: 2.99 },
  { name: "DoorDash agent", tools: ["search_restaurants", "get_menu", "add_to_cart"], feeUsd: 3.49 },
  { name: "Grubhub agent", tools: ["search_restaurants", "get_menu", "add_to_cart"], feeUsd: 1.99 },
];

function simulatedPlatform(p: Platform, req: OrderRequest, address: Place, area: string, fault: DemoFault): Provider<Cart> {
  return {
    name: p.name,
    source: "simulated",
    precheck: () => (p.tools.includes("add_to_cart") ? null : `can ${p.tools.join(" and ").replace(/_/g, " ")}, but has no add-to-cart tool`),
    run: async (signal) => {
      await new Promise((r) => setTimeout(r, 250));
      if (fault === "timeout") await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
      const found = pick(req, area);
      if (!found) throw new Error(`no restaurant${area ? ` in ${area}` : ""} on ${p.name.split(" ")[0]} sells "${req.item}"`);
      const qty = Math.max(1, Math.min(20, Math.round(req.quantity ?? 1)));
      const subtotal = round(found.item.priceUsd * qty);
      return {
        cartId: `cart_${randomUUID().slice(0, 8)}`,
        platform: p.name,
        restaurant: found.restaurant.name,
        restaurantCity: found.restaurant.city,
        items: [{ name: found.item.name, quantity: qty, priceUsd: found.item.priceUsd }],
        subtotalUsd: subtotal,
        deliveryFeeUsd: p.feeUsd,
        totalUsd: round(subtotal + p.feeUsd),
        // The silent failure we inject: the agent quietly uses the account's saved address.
        deliverTo: fault === "wrong_address" ? "1 Hacker Way, Menlo Park, CA 94025" : address.address,
        status: "in_cart",
        simulated: true,
      };
    },
  };
}

/** Real Darwin delivery agents, tried first. Without Act access they're listed and skipped. */
async function darwinPlatforms(): Promise<{ providers: Provider<Cart>[]; attempts: Attempt[] }> {
  // Without Act no Darwin agent can run, so don't spend a search (and its latency) finding one.
  if (!actConfigured()) {
    return {
      providers: [],
      attempts: [{ step: "find delivery agents", agent: "Darwin delivery agents", source: "darwin", outcome: "skipped", reason: "Darwin Act access isn't granted yet (pilot allowlist); going straight to backups", ms: 0 }],
    };
  }
  const query = "food delivery agent that adds restaurant menu items to a cart for delivery";
  try {
    const found = await findAgents(query, 3);
    const providers = found.agents.slice(0, 2).map<Provider<Cart>>((a) => ({
      name: a.name,
      source: "darwin",
      precheck: () => "found on Darwin, but its cart output isn't mapped yet; using the next backup",
      run: async () => {
        throw new BlockedError("unreachable");
      },
    }));
    return { providers, attempts: [] };
  } catch (err) {
    return {
      providers: [],
      attempts: [{ step: "find delivery agents", agent: "Darwin Search", source: "darwin", outcome: "failed", reason: `search failed (${(err as Error).message}); using pre-approved backups`, ms: 0 }],
    };
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

export function verifyCart(req: OrderRequest, address: Place, area: string) {
  return (cart: Cart): string | null => {
    if (cart.status !== "in_cart") return "the agent went past the cart; Axolotl never checks out without you";
    if (!cart.items.some((i) => itemMatches(req.item, i.name))) return `cart holds ${cart.items.map((i) => i.name).join(", ")}, not "${req.item}"`;
    if (area && fold(cart.restaurantCity) !== fold(area)) return `restaurant is in ${cart.restaurantCity}, not ${area}`;
    if (fold(cart.deliverTo) !== fold(address.address)) return `cart delivers to "${cart.deliverTo}", not the resolved address "${address.address}"`;
    if (req.maxTotalUsd !== undefined && cart.totalUsd > req.maxTotalUsd) return `total $${cart.totalUsd.toFixed(2)} is over your $${req.maxTotalUsd.toFixed(2)} cap`;
    return null;
  };
}

export async function orderFood(req: OrderRequest, opts: { fetchImpl?: typeof fetch } = {}): Promise<OrderResult> {
  const address = await resolvePlace(req.deliverTo, { fetchImpl: opts.fetchImpl });
  const attempts = [...address.attempts];
  if (!address.place) {
    return { status: "address_unresolved", cart: null, address, attempts, needsFromYou: `No map source could find "${req.deliverTo}". Ask for a street address.` };
  }
  if (address.status === "ambiguous") {
    return {
      status: "address_ambiguous",
      cart: null,
      address,
      attempts,
      needsFromYou: `"${req.deliverTo}" matches more than one place: ${[address.place, ...address.alternatives].map((p) => p.address).join(" | ")}. Ask which one.`,
    };
  }
  const place = address.place;
  // No area given: deliver from the delivery city when anything there sells the item.
  const area = req.area?.trim() || (place.city && pick(req, place.city) ? place.city : "");

  const darwin = await darwinPlatforms();
  attempts.push(...darwin.attempts);
  const fault = req.demoFault ?? "none";
  const providers = [
    ...darwin.providers,
    // The injected fault hits the first platform that can actually build a cart.
    ...PLATFORMS.map((p) => simulatedPlatform(p, req, place, area, p.name.startsWith("DoorDash") ? fault : "none")),
  ];
  const cartStep = await failover("build cart", providers, verifyCart(req, place, area), { timeoutMs: 4_000 });
  attempts.push(...cartStep.attempts);
  if (!cartStep.value) {
    return { status: "unfulfilled", cart: null, address, attempts, needsFromYou: "Every delivery agent failed; see the attempts. Nothing was ordered." };
  }
  carts().set(cartStep.value.cartId, cartStep.value);
  return {
    status: "awaiting_confirmation",
    cart: cartStep.value,
    address,
    attempts,
    needsFromYou: `Confirm to place the order ($${cartStep.value.totalUsd.toFixed(2)}). Axolotl stops at checkout; payment always needs you.`,
  };
}

export function confirmOrder(cartId: string): Cart | null {
  const cart = carts().get(cartId);
  if (!cart) return null;
  cart.status = "placed";
  return cart;
}
