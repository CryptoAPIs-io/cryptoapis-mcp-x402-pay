/**
 * The transport-independent half of paying an x402 challenge.
 *
 * Given the merchant's `accepts` list, this picks a requirement, authorizes it with the
 * CryptoAPIs buyer service, signs LOCALLY, and returns the `PaymentPayload` to resubmit. It
 * knows nothing about HTTP or MCP — the caller decides how the challenge arrived and how the
 * payload travels back (a base64 `X-PAYMENT` header over HTTP, a raw object in
 * `_meta["x402/payment"]` over MCP).
 *
 * Extracted so both transports run ONE implementation: the authorize→sign→build flow is
 * identical, and a fix or a newly-enabled family must never land on only one of them. (The
 * buyer SDK made the same split for the same reason — see its `payFlow.js`.)
 */

import {
    evmSignTypedData,
    svmPartialSign,
    tronSignFromDetails,
    utxoSignFromDetails,
    kaspaSignFromDetails,
    xrpSignFromDetails,
} from "@cryptoapis-io/mcp-signer";

export const DEFAULT_BUYER_BASE_URL = "https://ai.cryptoapis.io/x402/buyer";
export const X402_VERSION = 2;

/** The WIRE payment scheme is ALWAYS "exact" — the facilitator derives the family from `network`. */
export const SCHEME_EXACT = "exact";

/** Artifact schemes live-verified end-to-end. Enabling a family = add its scheme here. */
export const SUPPORTED_SCHEMES = new Set(["eip712", "svm-transaction"]);

/** UTXO CAIP-2 → the {blockchain, network} pair mcp-signer's utxo-sign needs. */
export const UTXO_CAIP2: Record<string, { blockchain: string; network: string }> = {
    "bip122:000000000019d6689c085ae165831e93": { blockchain: "bitcoin", network: "mainnet" },
    "bip122:000000000933ea01ad0ee984209779ba": { blockchain: "bitcoin", network: "testnet" },
    "bip122:12a765e31ffd4059bada1e25190f6e98": { blockchain: "litecoin", network: "mainnet" },
    "bip122:4966625a4b2851d9fdee139e56211a0d": { blockchain: "litecoin", network: "testnet" },
    "bip122:1a91e3dace36e2be3bf030a65679fe82": { blockchain: "dogecoin", network: "mainnet" },
    "bip122:bb0a78264637406b6360aad926284d54": { blockchain: "dogecoin", network: "testnet" },
    "bip122:00000ffd590b1485b3caadc19b22e637": { blockchain: "dash", network: "mainnet" },
    "bip122:00000bafbc94add76cb75e2ec92894837": { blockchain: "dash", network: "testnet" },
    "bip122:000000000000000000651ef99cb9fcbe": { blockchain: "bitcoin-cash", network: "mainnet" },
    "bip122:00000000dfd5d65c9d8561b4b8f60a63": { blockchain: "bitcoin-cash", network: "testnet" },
    "bip122:0007104ccda289427919efc39dc9e4d4": { blockchain: "zcash", network: "mainnet" },
    "bip122:05a60a92d99d85997cce3b87616c089f": { blockchain: "zcash", network: "testnet" },
};

export type PaymentRequirements = {
    scheme: string; network: string; amount: string; asset: string;
    payTo: string; maxTimeoutSeconds?: number; extra?: Record<string, unknown>;
};

/** Per-family signing keys, already resolved from params/env by the caller. */
export type SigningKeys = {
    evm?: string; tron?: string; svm?: string; utxo?: string; kaspa?: string; xrp?: string;
};

/** Either a built payload, or a clean refusal reason. Never throws for an expected refusal. */
export type BuildResult =
    | { ok: true; paymentPayload: Record<string, unknown>; requirements: PaymentRequirements }
    | { ok: false; reason: string };

/**
 * Pick which offered requirement to pay: the first whose network is allowed, else the first.
 *
 * @param accepts the merchant's PaymentRequirements list
 * @param allowed optional CAIP-2 allowlist
 * @returns the chosen requirements, or null when none is acceptable
 */
export function selectRequirements(accepts: PaymentRequirements[], allowed?: string[]): PaymentRequirements | null {
    if (accepts.length === 0) return null;
    if (Array.isArray(allowed) && allowed.length > 0) {
        return accepts.find((r) => allowed.includes(r.network)) ?? null;
    }
    return accepts[0] ?? null;
}

/**
 * Authorize + sign one x402 challenge into a resubmittable PaymentPayload.
 *
 * @param params inputs
 * @returns the payload to resubmit, or a refusal with an actionable reason
 */
export async function buildPaymentForChallenge(params: {
    accepts: PaymentRequirements[];
    apiKey: string;
    walletId: string;
    keys: SigningKeys;
    allowedNetworks?: string[];
    maxAmount?: string;
    buyerBaseUrl?: string;
    /**
     * The resource being paid for — the URL fetched (HTTP) or the challenge's ResourceInfo (MCP).
     * x402 v2 carries no resource inside PaymentRequirements, so without it the buyer service
     * cannot check the wallet's `allowedDomains` and refuses `domain_not_allowed`.
     */
    resource?: string | { url?: string };
}): Promise<BuildResult> {
    const requirements = selectRequirements(params.accepts, params.allowedNetworks);
    if (!requirements) {
        return { ok: false, reason: "no acceptable payment option" };
    }
    if (params.maxAmount != null && BigInt(requirements.amount) > BigInt(params.maxAmount)) {
        return { ok: false, reason: `required amount ${requirements.amount} exceeds maxAmount ${params.maxAmount}` };
    }

    // 1. Authorize via the buyer service → the artifact to sign.
    const root = (params.buyerBaseUrl ?? DEFAULT_BUYER_BASE_URL).replace(/\/$/, "");
    const authRes = await fetch(`${root}/authorize`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": params.apiKey },
        body: JSON.stringify({
            paymentRequirements: requirements,
            walletId: params.walletId,
            ...(params.resource ? { resource: params.resource } : {}),
        }),
    });
    if (!authRes.ok) {
        return { ok: false, reason: `buyer /authorize failed: ${authRes.status} ${await authRes.text()}`.trim() };
    }
    const auth = await authRes.json() as {
        authorized?: boolean; scheme?: string; signingPayload?: Record<string, unknown>; reason?: string;
    };
    if (auth.authorized === false) {
        return { ok: false, reason: `authorize refused: ${auth.reason ?? "unknown"}` };
    }

    // Gate off families that are wired but not yet live-verified.
    if (!auth.scheme || !SUPPORTED_SCHEMES.has(auth.scheme)) {
        return {
            ok: false,
            reason: `family_not_yet_supported: the "${auth.scheme}" family is coming soon — only EVM (eip712) and Solana (svm-transaction) are supported today`,
        };
    }

    // 2. Sign LOCALLY + build the payload. Every family's facilitator parsePayload reads
    //    `payload.transaction` first, so the non-EVM families use a uniform wrapper with the
    //    per-family value the facilitator expects.
    const network = requirements.network;
    const sp = auth.signingPayload ?? {};
    const keys = params.keys;
    let payload: Record<string, unknown>;

    /** A family whose signing key wasn't configured errors cleanly (never mis-signs). */
    const needKey = (key: string | undefined, envName: string): string | null =>
        (key ? null : `no signing key for ${auth.scheme} — set ${envName} (or the matching param)`);

    if (auth.scheme === "eip712") {
        const missing = needKey(keys.evm, "X402_PRIVATE_KEY");
        if (missing) return { ok: false, reason: missing };
        const td = sp as { domain: Record<string, unknown>; types: Record<string, { name: string; type: string }[]>; primaryType: string; message: Record<string, unknown> };
        const { signature } = await evmSignTypedData({
            action: "sign-typed-data",
            privateKey: keys.evm as string,
            domain: td.domain,
            types: td.types,
            primaryType: td.primaryType,
            message: td.message,
        });
        payload = { signature, authorization: td.message };
    } else if (auth.scheme === "svm-transaction") {
        const missing = needKey(keys.svm, "X402_SVM_SECRET");
        if (missing) return { ok: false, reason: missing };
        const { transaction } = svmPartialSign({
            action: "partial-sign",
            secretKeyBase58: keys.svm as string,
            transaction: sp.transaction as string,
        });
        payload = { transaction };
    } else if (auth.scheme === "tron-transaction") {
        const missing = needKey(keys.tron, "X402_TRON_KEY");
        if (missing) return { ok: false, reason: missing };
        const { signedTransaction } = tronSignFromDetails({
            action: "sign-from-details",
            privateKey: keys.tron as string,
            transaction: sp.transaction as Record<string, unknown>,
        });
        payload = { transaction: signedTransaction };
    } else if (auth.scheme === "utxo-transaction") {
        const missing = needKey(keys.utxo, "X402_UTXO_WIF");
        if (missing) return { ok: false, reason: missing };
        const chain = UTXO_CAIP2[network];
        if (!chain) return { ok: false, reason: `unknown UTXO network ${network}` };
        const { signedTransactionHex } = utxoSignFromDetails({
            action: "sign-from-details",
            blockchain: chain.blockchain as never,
            network: chain.network as never,
            privateKeys: [keys.utxo as string],
            preparedTransaction: sp.preparedTransaction as Record<string, unknown>,
        });
        payload = { transaction: signedTransactionHex };
    } else if (auth.scheme === "kaspa-transaction") {
        const missing = needKey(keys.kaspa, "X402_KASPA_KEY");
        if (missing) return { ok: false, reason: missing };
        const { signedTransaction } = kaspaSignFromDetails({
            action: "sign-from-details",
            privateKeys: [keys.kaspa as string],
            preparedTransaction: sp.preparedTransaction as Record<string, unknown>,
        });
        payload = { transaction: signedTransaction };
    } else if (auth.scheme === "xrp-transaction") {
        const missing = needKey(keys.xrp, "X402_XRP_SEED");
        if (missing) return { ok: false, reason: missing };
        const { signedTransactionHex } = await xrpSignFromDetails({
            action: "sign-from-details",
            secret: keys.xrp as string,
            transaction: sp.transaction as Record<string, unknown>,
        });
        payload = { transaction: signedTransactionHex };
    } else {
        return { ok: false, reason: `unsupported_scheme: ${auth.scheme}` };
    }

    // `accepted` is Required in x402 v2 (§5.2.2) and carries scheme/network; a v1 merchant
    // instead matches on the top-level fields. Emit both so a merchant reading either shape
    // pairs the payment with the requirement it actually offered. Shared by the HTTP payer
    // and the MCP tool payer, so neither transport can drift from the other.
    return {
        ok: true,
        requirements,
        paymentPayload: {
            x402Version: X402_VERSION,
            scheme: SCHEME_EXACT,
            network: network,
            accepted: { ...requirements },
            payload: payload,
        },
    };
}

/**
 * Resolve the per-family signing keys from explicit params, then env.
 *
 * Tron falls back to the EVM key (same secp256k1 curve); the others have no safe fallback,
 * since a hex key cannot sign a base58/WIF/seed payment.
 *
 * @param input the tool input carrying optional per-family keys
 * @returns the resolved keys
 */
export function resolveSigningKeys(input: {
    privateKey?: string; tronKey?: string; svmSecret?: string;
    utxoWif?: string; kaspaKey?: string; xrpSeed?: string;
}): SigningKeys {
    const evm = input.privateKey ?? process.env.X402_PRIVATE_KEY;
    return {
        evm,
        tron: input.tronKey ?? process.env.X402_TRON_KEY ?? evm,
        svm: input.svmSecret ?? process.env.X402_SVM_SECRET,
        utxo: input.utxoWif ?? process.env.X402_UTXO_WIF,
        kaspa: input.kaspaKey ?? process.env.X402_KASPA_KEY,
        xrp: input.xrpSeed ?? process.env.X402_XRP_SEED,
    };
}
