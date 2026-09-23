import * as z from "zod";

/**
 * Call a TOOL on another MCP server and, if it answers with an x402 payment challenge, pay it
 * and retry — the MCP-transport twin of `x402_pay` (which pays HTTP urls).
 *
 * Same credentials and per-family keys as `x402_pay`; only the envelope differs. See
 * `specs/transports-v2/mcp.md`.
 */
export const X402PayToolSchema = z.object({
    // --- which upstream tool to call -------------------------------------------------------
    server: z.object({
        command: z.string().describe("Executable to launch the upstream MCP server, e.g. \"npx\""),
        args: z.array(z.string()).optional().describe("Arguments, e.g. [\"-y\",\"@vendor/their-mcp-server\"]"),
        env: z.record(z.string(), z.string()).optional().describe("Extra env for the upstream process (its own credentials, if it needs any)"),
    }).describe("The upstream MCP server to call, launched over stdio. It is started for this call and shut down afterwards."),

    toolName: z.string().describe("The name of the tool to call on that server"),
    arguments: z.record(z.string(), z.unknown()).optional().describe("Arguments to pass to that tool"),

    // --- credentials (identical to x402_pay) -----------------------------------------------
    apiKey: z.string().optional().describe("Your CryptoAPIs API key with the X402_BUYER feature (used only to call the buyer /authorize). Falls back to the CRYPTOAPIS_API_KEY env var."),
    walletId: z.string().optional().describe("The CryptoAPIs buyer-service wallet RECORD ID (from POST /wallets) — NOT the on-chain address. Falls back to the X402_WALLET_ID env var."),

    // --- per-family signing keys (identical to x402_pay) -----------------------------------
    privateKey: z.string().optional().describe("EVM private key (hex, 0x optional) — signs the eip712 payment, and Tron by default. Falls back to X402_PRIVATE_KEY. SECURITY: trusted local environments only."),
    tronKey: z.string().optional().describe("Tron private key (hex). Falls back to X402_TRON_KEY, then to privateKey/X402_PRIVATE_KEY."),
    svmSecret: z.string().optional().describe("Solana secret key, base58-encoded — signs svm-transaction payments. Falls back to X402_SVM_SECRET."),
    utxoWif: z.string().optional().describe("UTXO private key in WIF format. Falls back to X402_UTXO_WIF."),
    kaspaKey: z.string().optional().describe("Kaspa private key (hex). Falls back to X402_KASPA_KEY."),
    xrpSeed: z.string().optional().describe("XRP secret/seed. Falls back to X402_XRP_SEED."),

    // --- guardrails -------------------------------------------------------------------------
    allowedNetworks: z.array(z.string()).optional().describe("Restrict which CAIP-2 networks to pay on (e.g. [\"eip155:8453\"])"),
    maxAmount: z.string().optional().describe("Safety cap: refuse to pay if the required atomic-unit amount exceeds this"),
    buyerBaseUrl: z.string().url().optional().describe("Override the buyer service base URL (default https://ai.cryptoapis.io/x402/buyer)"),
});

export type X402PayToolInput = z.infer<typeof X402PayToolSchema>;
