import * as z from "zod";

/**
 * Fetch an HTTP resource and, if it responds 402 Payment Required, pay it with x402:
 * authorize via the CryptoAPIs buyer service, sign LOCALLY, retry. Non-custodial —
 * the private key is passed per request and never leaves this process.
 *
 * Supports all six x402 families. Each family signs with ITS OWN key form — a
 * single hex key can't sign a Solana (base58), UTXO (WIF) or XRP (seed) payment,
 * so those take their own optional key/env. An agent only sets the key(s) for the
 * chain(s) it actually pays on; a scheme with no configured key errors cleanly
 * rather than mis-signing.
 */
export const X402PaySchema = z.object({
    url: z.string().url().describe("The (possibly paywalled) resource URL to fetch"),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional().describe("HTTP method (default GET)"),
    body: z.string().optional().describe("Request body (string; set content-type via headers if needed)"),
    headers: z.record(z.string(), z.string()).optional().describe("Extra request headers"),

    apiKey: z.string().optional().describe("Your CryptoAPIs API key with the X402_BUYER feature (used only to call the buyer /authorize). Falls back to the CRYPTOAPIS_API_KEY env var — set it once and omit this."),
    walletId: z.string().optional().describe("The CryptoAPIs buyer-service wallet RECORD ID (the id returned by POST /wallets) — NOT the on-chain address; passing an address returns wallet_not_found. Falls back to the X402_WALLET_ID env var. Create one first (once per blockchain+network): POST https://ai.cryptoapis.io/x402/buyer/wallets with {blockchain, network (CAIP-2 id like eip155:8453 or solana:<genesisHash> — NOT a bare name), address (your public address; required for Solana/Kaspa)} → returns walletId."),

    // Per-family signing keys — pass only the one(s) for the chain(s) you pay on.
    // All SIGN LOCALLY and are never sent anywhere; each falls back to its env var
    // (PREFERRED — keeps the key out of tool-call logs).
    privateKey: z.string().optional().describe("EVM private key (hex, 0x optional) — signs the eip712 (EVM) payment, and Tron by default. Falls back to X402_PRIVATE_KEY. SECURITY: trusted local environments only."),
    tronKey: z.string().optional().describe("Tron private key (hex). Falls back to X402_TRON_KEY, then to privateKey/X402_PRIVATE_KEY (same secp256k1 curve)."),
    svmSecret: z.string().optional().describe("Solana secret key, base58-encoded (64-byte keypair secret) — signs svm-transaction payments. Falls back to X402_SVM_SECRET."),
    utxoWif: z.string().optional().describe("UTXO private key in WIF format — signs utxo-transaction payments (bitcoin/ltc/doge/dash/bch/zcash). Falls back to X402_UTXO_WIF."),
    kaspaKey: z.string().optional().describe("Kaspa private key (hex, 32 bytes) — signs kaspa-transaction payments. Falls back to X402_KASPA_KEY."),
    xrpSeed: z.string().optional().describe("XRP secret/seed (base58, e.g. s...) — signs xrp-transaction payments. Falls back to X402_XRP_SEED."),

    allowedNetworks: z.array(z.string()).optional().describe("Restrict which CAIP-2 networks to pay on (e.g. [\"eip155:8453\"])"),
    buyerBaseUrl: z.string().url().optional().describe("Override the buyer service base URL (default https://ai.cryptoapis.io/x402/buyer)"),
    maxAmount: z.string().optional().describe("Optional safety cap: refuse to pay if the required atomic-unit amount exceeds this"),
});

export type X402PayInput = z.infer<typeof X402PaySchema>;
