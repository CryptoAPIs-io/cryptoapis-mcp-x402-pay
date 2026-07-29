import type { X402DiscoverInput } from "./schema.js";
import { X402DiscoverSchema } from "./schema.js";
import type { McpX402ToolDef } from "../types.js";

const DEFAULT_FACILITATOR_BASE_URL = "https://ai.cryptoapis.io/x402/merchant";

/** One catalogue entry as the facilitator returns it (x402 v2 §8.2). */
type DiscoveredResource = {
    resource: string;
    type: string;
    x402Version: number;
    accepts: {
        scheme: string;
        network: string;
        amount: string;
        asset: string;
        payTo: string;
        maxTimeoutSeconds?: number;
        extra?: Record<string, unknown>;
    }[];
    lastUpdated: number;
    metadata?: Record<string, unknown>;
};

/**
 * List x402-enabled resources from the facilitator's Bazaar catalogue.
 *
 * No credential is sent: `/discovery/resources` is public by design, so an agent can
 * survey what is for sale — and at what price — before deciding whether to spend.
 */
async function x402Discover(input: X402DiscoverInput): Promise<{
    resources: DiscoveredResource[];
    pagination: { limit: number; offset: number; total: number };
}> {
    const root = (input.facilitatorBaseUrl ?? DEFAULT_FACILITATOR_BASE_URL).replace(/\/$/, "");
    const params = new URLSearchParams();
    if (input.type !== undefined) params.set("type", input.type);
    if (input.limit !== undefined) params.set("limit", String(input.limit));
    if (input.offset !== undefined) params.set("offset", String(input.offset));
    const qs = params.toString();

    const res = await fetch(`${root}/discovery/resources${qs ? `?${qs}` : ""}`, { method: "GET" });
    if (!res.ok) {
        // 503 here means the catalogue is unreadable, NOT that there is nothing for sale —
        // surface the difference so the agent retries instead of concluding "no resources".
        throw new Error(`x402 discovery failed: ${res.status} ${await res.text().catch(() => "")}`.trim());
    }
    const body = (await res.json()) as {
        items?: DiscoveredResource[];
        pagination?: { limit: number; offset: number; total: number };
    };
    return {
        resources: body.items ?? [],
        pagination: body.pagination ?? { limit: 0, offset: 0, total: 0 },
    };
}

export const x402DiscoverTool: McpX402ToolDef<typeof X402DiscoverSchema> = {
    name: "x402_discover",
    description:
        "Discover x402-gated APIs you can pay for — browse the facilitator's Bazaar catalogue of registered x402 resources, each with the price and payment terms it accepts. Use this BEFORE x402_pay whenever you need to FIND a paid endpoint rather than call one you were already given: the pay tool only fetches a URL you hand it, so this is the only way to locate a monetized API on your own. Returns { resources: [{ resource, type, x402Version, accepts: [{ scheme, network, amount, asset, payTo }], lastUpdated, metadata? }], pagination: { limit, offset, total } } — `amount` is in ATOMIC units (USDC 6-decimals: \"10000\" = $0.01), so convert before quoting a price to the user. PUBLIC: needs no API key, no wallet and spends nothing, so it is always safe to call. Filter with `type` (e.g. \"http\") and page with `limit`/`offset`. Then pass a chosen `resource` URL to x402_pay to actually buy it.",
    inputSchema: X402DiscoverSchema,
    handler: async (input: X402DiscoverInput) => {
        const result = await x402Discover(input);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
};
