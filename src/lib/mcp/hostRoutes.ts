// Real carts through the host's own tools. Axolotl can't call another plugin (MCP servers only talk
// to their host), but the host can: so Axolotl plans which of the host's tools to use and in what
// order, resolves the address they need, and then verifies the real cart the host reports back.
// Failover is the host walking the plan; verification decides when to move to the next route.
import { foldText, type Place } from "@/lib/mcp/places";
import { tokens } from "@/lib/mcp/ordering";

export interface HostRoute {
  id: string;
  via: string;
  kind: "plugin_cart" | "plugin_search_then_browser" | "browser_site";
  /** Why Axolotl chose this route, in one line the host can repeat to the person. */
  why: string;
  steps: string[];
}

interface Provider {
  name: string;
  /** Matches the provider in a tool name or description. */
  match: RegExp;
  /** Store search on the provider's own site, for when no plugin covers it. */
  searchUrl: (item: string) => string;
  /** Restaurants (true) or groceries only. */
  restaurants: boolean;
}

const PROVIDERS: Provider[] = [
  { name: "Uber Eats", match: /uber[\s_-]*eats|ubereats/i, searchUrl: (q) => `https://www.ubereats.com/search?diningMode=DELIVERY&q=${encodeURIComponent(q)}`, restaurants: true },
  { name: "DoorDash", match: /door[\s_-]*dash/i, searchUrl: (q) => `https://www.doordash.com/search/store/${encodeURIComponent(q)}/`, restaurants: true },
  { name: "Grubhub", match: /grub[\s_-]*hub/i, searchUrl: (q) => `https://www.grubhub.com/search?queryText=${encodeURIComponent(q)}`, restaurants: true },
  { name: "Instacart", match: /instacart/i, searchUrl: (q) => `https://www.instacart.com/store/s?k=${encodeURIComponent(q)}`, restaurants: false },
];

const CART_WORDS = /\b(add[\s_-]*to[\s_-]*cart|cart|basket|checkout|place[\s_-]*order|create[\s_-]*order)\b/i;
const BROWSER_WORDS = /\b(browser|computer[\s_-]*use|cua|playwright|navigate|web[\s_-]*page|chrome)\b/i;

export interface HostTool {
  name: string;
  description?: string;
}

/** Accepts ["uber_eats_search", "doordash: Quick delivery on groceries", {name, description}]. */
export function parseHostTools(input: unknown): HostTool[] {
  if (!Array.isArray(input)) return [];
  return input.flatMap((t): HostTool[] => {
    if (typeof t === "string" && t.trim()) {
      const [name, ...rest] = t.split(":");
      return [{ name: name.trim(), description: rest.join(":").trim() || undefined }];
    }
    if (t && typeof t === "object" && typeof (t as HostTool).name === "string") return [{ name: (t as HostTool).name, description: (t as HostTool).description }];
    return [];
  }).slice(0, 60);
}

/** Most likely to produce a real cart first: a plugin with a cart tool, then plugin search + browser, then the site in the browser. */
export function planHostRoutes(item: string, address: Place, toolsIn: HostTool[], canBrowse: boolean, groceries: boolean, located = false): HostRoute[] {
  const text = (t: HostTool) => `${t.name} ${t.description ?? ""}`;
  // A plugin that says it only does groceries can't fetch restaurant food, even if its company can.
  const usable = (t: HostTool) => groceries || !/grocer/i.test(t.description ?? "") || /restaurant|takeout|meal/i.test(t.description ?? "");
  const browserTool = toolsIn.find((t) => BROWSER_WORDS.test(text(t)))?.name;
  const browser = canBrowse || Boolean(browserTool);
  const yourBrowser = browserTool ? `your browser tool (${browserTool})` : "your browser";
  const tools = toolsIn.filter(usable);
  const routes: HostRoute[] = [];
  const addr = address.address;
  const providers = PROVIDERS.filter((p) => groceries || p.restaurants || tools.some((t) => p.match.test(text(t))));

  for (const p of providers) {
    const mine = tools.filter((t) => p.match.test(text(t)));
    const cartTool = mine.find((t) => CART_WORDS.test(text(t)));
    if (cartTool) {
      routes.push({
        id: `${slug(p.name)}-plugin-cart`,
        via: `${p.name} plugin (${cartTool.name})`,
        kind: "plugin_cart",
        why: `${cartTool.name} can add to the cart directly, so it goes first.`,
        steps: [`Call ${cartTool.name} to add 1 × "${item}" with delivery address "${addr}".`, "Read back the cart it returns."],
      });
    }
  }
  for (const p of providers) {
    const search = tools.find((t) => p.match.test(text(t)) && !CART_WORDS.test(text(t)));
    if (search && browser) {
      routes.push({
        id: `${slug(p.name)}-search-browser`,
        via: `${p.name} plugin search, then ${yourBrowser}`,
        kind: "plugin_search_then_browser",
        why: `The ${p.name} plugin (${search.name}) can find the food but has no add-to-cart tool, so Axolotl routes the cart step around it through ${yourBrowser}.`,
        steps: [
          `Call ${search.name} for "${item}" with address "${addr}" (delivery).`,
          `Open the best matching store's link with ${yourBrowser}. If the page asks for a delivery address, set it to the address above.`,
          `Add 1 × the matching item to the cart. Choose free/default options; skip paid extras.`,
          "Open the cart and read what it shows (items, subtotal, delivery address). Do not check out.",
        ],
      });
    }
  }
  if (browser) {
    for (const p of providers.filter((pr) => pr.restaurants || groceries)) {
      if (!located && routes.some((r) => r.id.startsWith(slug(p.name)))) continue;
      routes.push({
        id: `${slug(p.name)}-site`,
        via: `${p.name} website in ${yourBrowser}`,
        kind: "browser_site",
        why: tools.some((t) => p.match.test(text(t)))
          ? `The ${p.name} plugin can't add to a cart and wants the person to type the address, so Axolotl goes straight to the ${p.name} website through ${yourBrowser} with the address it located.`
          : `No ${p.name} plugin here, so Axolotl uses the ${p.name} website through ${yourBrowser}.`,
        steps: [
          `Open ${p.searchUrl(item)} with ${yourBrowser} and set the delivery address to "${addr}".`,
          `Pick a store that sells "${item}", add 1 to the cart, choosing free/default options.`,
          "Open the cart and read what it shows. Do not check out. If it needs a sign-in you don't have, move to the next route.",
        ],
      });
    }
  }
  // A located address goes in the delivery site directly. Plugin searches whose rules make the person
  // type the address again come after, still available as a backup.
  if (located) {
    const rank = (r: HostRoute) => (r.kind === "plugin_cart" ? 0 : r.kind === "browser_site" ? 1 : 2);
    routes.sort((a, b) => rank(a) - rank(b));
  }
  return routes;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/\W+/g, "-");
}

const PLACED = /\b(order (placed|confirmed|received)|thanks for your order|order #\s*\w+|your order is (on the way|being prepared)|payment (complete|successful))\b/i;
const MONEY = /\$\s?(\d{1,4}(?:[.,]\d{2})?)/g;

export interface CartCheck {
  verdict: "pass" | "fail";
  problems: string[];
  found: { item: boolean; address: boolean; totalUsd?: number };
}

/** Checks the cart the host read back: right item, delivering to the resolved address, under budget, not checked out. */
export function verifyHostCart(cartText: string, item: string, address: Place, maxTotalUsd?: number): CartCheck {
  const text = foldText(cartText);
  const problems: string[] = [];
  if (PLACED.test(cartText)) problems.push("the order looks placed; Axolotl only builds carts and leaves checkout to you");

  const want = tokens(item);
  const have = new Set(tokens(cartText));
  const itemOk = want.length > 0 && want.some((t) => have.has(t));
  if (!itemOk) problems.push(`nothing in the cart matches "${item}"`);

  // Address: the house number and the street's first word must both appear.
  const street = foldText(address.street).split(/\s+/)[0] ?? "";
  const addressOk = Boolean(address.houseNumber && text.includes(foldText(address.houseNumber)) && street && text.includes(street));
  if (!addressOk) problems.push(`the cart doesn't show delivery to ${address.address}; set the address in the cart and read it again`);

  const amounts = [...cartText.matchAll(MONEY)].map((m) => Number(m[1].replace(",", ".")));
  const totalUsd = amounts.length ? Math.max(...amounts) : undefined;
  if (maxTotalUsd !== undefined && totalUsd !== undefined && totalUsd > maxTotalUsd) problems.push(`total $${totalUsd.toFixed(2)} is over the $${maxTotalUsd.toFixed(2)} cap`);

  return { verdict: problems.length ? "fail" : "pass", problems, found: { item: itemOk, address: addressOk, totalUsd } };
}

/** A route id as a name for the rankings: "uber-eats-search-browser" -> "Uber Eats: plugin search, then browser". */
export function routeName(routeId: string): string {
  const p = PROVIDERS.find((pr) => routeId.startsWith(`${slug(pr.name)}-`));
  if (!p) return routeId;
  const how = routeId.endsWith("-plugin-cart") ? "plugin cart" : routeId.endsWith("-search-browser") ? "plugin search, then browser" : routeId.endsWith("-site") ? "website in browser" : routeId.slice(slug(p.name).length + 1);
  return `${p.name}: ${how}`;
}

/** One line the host can show the person, so they can see what Axolotl did. */
export function creditLine(routeId: string, address: Place, locatedFrom: string | null): string {
  const where = locatedFrom ? `located ${locatedFrom}` : `checked ${address.address} on the map`;
  const how = routeId.endsWith("-search-browser")
    ? "routed around the plugin's missing add-to-cart tool by building the cart in the browser"
    : routeId.endsWith("-site")
      ? "built the cart on the delivery website in the browser because the plugin can't add to a cart"
      : "picked the plugin that can add to the cart";
  return `Axolotl ${where}, ${how}, and verified the cart (right item, right address, not checked out).`;
}
