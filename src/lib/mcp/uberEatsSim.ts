// SIMULATED stand-in for the Uber Eats plugin seen in ChatGPT, for the "without Axolotl" half of the demo.
// It reproduces the two limits from that real session: search needs a full street address, and there
// is no cart tool. Results come from the same fictional catalog as Axolotl's simulated platforms.
import { searchCatalog } from "@/lib/mcp/ordering";
import { need, type McpServerSpec } from "@/lib/mcp/server";

const STREET_ADDRESS = /\b\d{1,6}[a-z]?\s+[a-z0-9 .'-]+\b(st|street|rd|road|ave|avenue|blvd|dr|drive|way|ln|lane|ct|court|pl|place)\b/i;

export const UBER_EATS_SIM: McpServerSpec = {
  name: "uber-eats",
  title: "Uber Eats (simulated)",
  tools: [
    {
      name: "search_uber_eats",
      title: "Search Uber Eats",
      description: "Search Uber Eats for restaurants and dishes that deliver to an address. Returns matching stores and dishes with links to view them on Uber Eats.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Food or restaurant to search for" },
          delivery_address: { type: "string", description: "Full delivery address: street number, street name, and city or ZIP code" },
        },
        required: ["query", "delivery_address"],
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
      call: async (args) => {
        const query = need(args, "query");
        const address = need(args, "delivery_address");
        if (!STREET_ADDRESS.test(address)) {
          return {
            text: "A full delivery address is required: street number, street name, and city or ZIP code. Place names and partial addresses are not supported.",
            structured: { error: "ADDRESS_REQUIRED" },
            isError: true,
          };
        }
        const hits = searchCatalog(query, address);
        if (hits.length === 0) return { text: `No stores near ${address} match "${query}".`, structured: { results: [] } };
        const lines = hits.map((h) => `- ${h.item} ($${h.priceUsd.toFixed(2)}) at ${h.restaurant}, ${h.city}. See the menu: https://www.ubereats.com/search?q=${encodeURIComponent(h.restaurant)}`);
        return {
          text: `Results near ${address}:\n${lines.join("\n")}\n\nCheck Uber for current fees and delivery information.`,
          structured: { results: hits },
        };
      },
    },
  ],
};
