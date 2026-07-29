import * as z from "zod";

/**
 * Browse the x402 "Bazaar" — the catalogue of x402-enabled resources registered with a
 * facilitator, each with the payment requirements it accepts (x402 v2 §8).
 *
 * This is the FIND half of x402: `x402_pay` can only pay a URL it is handed, so without
 * discovery an agent can never locate a paid API on its own. The endpoint is PUBLIC — no
 * API key and no wallet — so browsing costs nothing and commits nothing.
 */
export const X402DiscoverSchema = z.object({
    type: z
        .string()
        .optional()
        .describe('Filter by resource type, e.g. "http". Omit to list every type.'),
    limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Max results to return, 1-100 (default 20). The facilitator clamps out-of-range values rather than erroring."),
    offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("How many results to skip, for paging (default 0). Use with `pagination.total` from a previous call."),
    facilitatorBaseUrl: z
        .string()
        .url()
        .optional()
        .describe("Override the facilitator base URL (default https://ai.cryptoapis.io/x402/merchant). Useful against QA/local."),
});

export type X402DiscoverInput = z.infer<typeof X402DiscoverSchema>;
