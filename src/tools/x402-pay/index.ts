import {
    evmSignTypedData,
    svmPartialSign,
    tronSignFromDetails,
    utxoSignFromDetails,
    kaspaSignFromDetails,
    xrpSignFromDetails,
} from "@cryptoapis-io/mcp-signer";
import type { X402PayInput } from "./schema.js";
import { X402PaySchema } from "./schema.js";
import type { McpX402ToolDef } from "../types.js";

const DEFAULT_BUYER_BASE_URL = "https://ai.cryptoapis.io/x402/buyer";
const X402_VERSION = 2;
/** The WIRE payment scheme is ALWAYS "exact" — the facilitator's parseEnvelope rejects
 *  anything else and derives the family from `network`. The buyer /authorize "scheme"
 *  (eip712/…) is the ARTIFACT type (how to sign), NOT this. */
const SCHEME_EXACT = "exact";

/** Artifact schemes that are LIVE-VERIFIED end-to-end and enabled today. EVM (eip712) and
 *  Solana (svm-transaction) are supported; Tron/UTXO/XRP/Kaspa are wired but not yet
 *  live-verified, so they are gated OFF ("coming soon") until each is exercised in prod.
 *  Enabling a family once verified = add its scheme here. */
const SUPPORTED_SCHEMES = new Set(["eip712", "svm-transaction"]);

/** UTXO CAIP-2 network id → the {blockchain, network} the mcp-signer utxo-sign needs
 *  (a bare CAIP-2 doesn't carry the chain name). Only UTXO signing needs this pair. */
const UTXO_CAIP2: Record<string, { blockchain: string; network: string }> = {
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

/** Decode the base64 x402 402 body JSON. */
type PaymentRequirements = {
    scheme: string; network: string; amount: string; asset: string;
    payTo: string; maxTimeoutSeconds?: number; extra?: Record<string, unknown>;
};

/** Pick which offered requirement to pay (allowlist-aware; else the first). */
function selectRequirements(accepts: PaymentRequirements[], allowed?: string[]): PaymentRequirements | null {
    if (accepts.length === 0) return null;
    if (Array.isArray(allowed) && allowed.length > 0) {
        return accepts.find((r) => allowed.includes(r.network)) ?? null;
    }
    return accepts[0] ?? null;
}

/**
 * Fetch a URL and auto-pay a 402 with x402 (EVM eip712 path).
 *
 * @param input the tool input
 * @return the final (paid) response summary
 */
export async function x402Pay(input: X402PayInput): Promise<{
    status: number; paid: boolean; body: string; settlement?: unknown; reason?: string;
}> {
    // Credentials: prefer the per-call params, else fall back to env (set once in the
    // MCP config so the agent only ever passes `url` — and the key stays out of logs).
    // apiKey + walletId are always needed (to call /authorize); the SIGNING key is
    // resolved per-family at the dispatch below (each chain uses its own key form).
    const apiKey = input.apiKey ?? process.env.CRYPTOAPIS_API_KEY;
    const walletId = input.walletId ?? process.env.X402_WALLET_ID;
    if (!apiKey || !walletId) {
        const missing = [!apiKey && "apiKey/CRYPTOAPIS_API_KEY", !walletId && "walletId/X402_WALLET_ID"].filter(Boolean).join(", ");
        return { status: 0, paid: false, reason: `missing credentials: ${missing} (pass as params or set the env vars)`, body: "" };
    }
    // Per-family signing keys (param → family env → EVM fallback where the curve allows).
    const evmKey = input.privateKey ?? process.env.X402_PRIVATE_KEY;
    const keys = {
        evm: evmKey,
        tron: input.tronKey ?? process.env.X402_TRON_KEY ?? evmKey,
        svm: input.svmSecret ?? process.env.X402_SVM_SECRET,
        utxo: input.utxoWif ?? process.env.X402_UTXO_WIF,
        kaspa: input.kaspaKey ?? process.env.X402_KASPA_KEY,
        xrp: input.xrpSeed ?? process.env.X402_XRP_SEED,
    };

    const method = input.method ?? "GET";
    const baseInit: RequestInit = {
        method,
        headers: { ...(input.headers ?? {}) },
        ...(input.body != null ? { body: input.body } : {}),
    };

    const first = await fetch(input.url, baseInit);
    if (first.status !== 402) {
        return { status: first.status, paid: false, body: await first.text() };
    }

    const body402 = await first.json().catch(() => null) as { accepts?: PaymentRequirements[] } | null;
    const accepts = Array.isArray(body402?.accepts) ? body402.accepts : [];
    const requirements = selectRequirements(accepts, input.allowedNetworks);
    if (!requirements) {
        return { status: 402, paid: false, reason: "no acceptable payment option", body: JSON.stringify(body402) };
    }
    if (input.maxAmount != null && BigInt(requirements.amount) > BigInt(input.maxAmount)) {
        return { status: 402, paid: false, reason: `required amount ${requirements.amount} exceeds maxAmount ${input.maxAmount}`, body: "" };
    }

    // 1. Authorize via the buyer service → the artifact to sign.
    const root = (input.buyerBaseUrl ?? DEFAULT_BUYER_BASE_URL).replace(/\/$/, "");
    const authRes = await fetch(`${root}/authorize`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": apiKey },
        body: JSON.stringify({ paymentRequirements: requirements, walletId: walletId }),
    });
    if (!authRes.ok) {
        return { status: 402, paid: false, reason: `buyer /authorize failed: ${authRes.status} ${await authRes.text()}`.trim(), body: "" };
    }
    const auth = await authRes.json() as { authorized?: boolean; scheme?: string; signingPayload?: Record<string, unknown>; reason?: string };
    if (auth.authorized === false) {
        return { status: 402, paid: false, reason: `authorize refused: ${auth.reason ?? "unknown"}`, body: "" };
    }

    // 2. Sign LOCALLY + build the PaymentPayload. The WIRE scheme is ALWAYS "exact"
    //    (family carried by `network`); the /authorize `scheme` says HOW to sign. Every
    //    family's facilitator parsePayload reads `payload.transaction` first — so the
    //    non-EVM families use a uniform `payload:{transaction}` wrapper, with the
    //    per-family value the facilitator expects (SVM base64, UTXO/XRP hex, Kaspa JSON,
    //    Tron the structured {txID, raw_data_hex, raw_data, signature[]} object).
    const network = requirements.network;

    // Gate off families that are wired but not yet live-verified (Tron/UTXO/XRP/Kaspa).
    // EVM + Solana are supported today; the rest are on the roadmap ("coming soon").
    if (!auth.scheme || !SUPPORTED_SCHEMES.has(auth.scheme)) {
        return {
            status: 402,
            paid: false,
            reason: `family_not_yet_supported: the "${auth.scheme}" family is coming soon — only EVM (eip712) and Solana (svm-transaction) are supported today`,
            body: "",
        };
    }

    const sp = auth.signingPayload ?? {};
    let payload: Record<string, unknown>;

    /** Guard: a family whose signing key wasn't configured errors cleanly (never mis-signs). */
    const needKey = (key: string | undefined, envName: string): string | null =>
        (key ? null : `no signing key for ${auth.scheme} — set ${envName} (or the matching param)`);

    if (auth.scheme === "eip712") {
        const missing = needKey(keys.evm, "X402_PRIVATE_KEY");
        if (missing) return { status: 402, paid: false, reason: missing, body: "" };
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
        if (missing) return { status: 402, paid: false, reason: missing, body: "" };
        const { transaction } = svmPartialSign({
            action: "partial-sign",
            secretKeyBase58: keys.svm as string,
            transaction: sp.transaction as string,
        });
        payload = { transaction };
    } else if (auth.scheme === "tron-transaction") {
        const missing = needKey(keys.tron, "X402_TRON_KEY");
        if (missing) return { status: 402, paid: false, reason: missing, body: "" };
        const { signedTransaction } = tronSignFromDetails({
            action: "sign-from-details",
            privateKey: keys.tron as string,
            transaction: sp.transaction as Record<string, unknown>,
        });
        // Tron's facilitator wants the structured {txID, raw_data_hex, raw_data, signature[]}.
        payload = { transaction: signedTransaction };
    } else if (auth.scheme === "utxo-transaction") {
        const missing = needKey(keys.utxo, "X402_UTXO_WIF");
        if (missing) return { status: 402, paid: false, reason: missing, body: "" };
        const chain = UTXO_CAIP2[network];
        if (!chain) return { status: 402, paid: false, reason: `unknown UTXO network ${network}`, body: "" };
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
        if (missing) return { status: 402, paid: false, reason: missing, body: "" };
        const { signedTransaction } = kaspaSignFromDetails({
            action: "sign-from-details",
            privateKeys: [keys.kaspa as string],
            preparedTransaction: sp.preparedTransaction as Record<string, unknown>,
        });
        payload = { transaction: signedTransaction };
    } else if (auth.scheme === "xrp-transaction") {
        const missing = needKey(keys.xrp, "X402_XRP_SEED");
        if (missing) return { status: 402, paid: false, reason: missing, body: "" };
        const { signedTransactionHex } = await xrpSignFromDetails({
            action: "sign-from-details",
            secret: keys.xrp as string,
            transaction: sp.transaction as Record<string, unknown>,
        });
        payload = { transaction: signedTransactionHex };
    } else {
        return { status: 402, paid: false, reason: `unsupported_scheme: ${auth.scheme}`, body: "" };
    }

    const paymentPayload: Record<string, unknown> = {
        x402Version: X402_VERSION,
        scheme: SCHEME_EXACT,
        network: network,
        payload: payload,
    };

    // 3. Retry the ORIGINAL request with the X-PAYMENT header.
    const xPayment = Buffer.from(JSON.stringify(paymentPayload), "utf8").toString("base64");
    const paid = await fetch(input.url, {
        ...baseInit,
        headers: { ...(baseInit.headers as Record<string, string>), "x-payment": xPayment },
    });
    const paymentResponse = paid.headers.get("x-payment-response");
    return {
        status: paid.status,
        paid: paid.status >= 200 && paid.status < 300,
        body: await paid.text(),
        settlement: paymentResponse ? JSON.parse(Buffer.from(paymentResponse, "base64").toString("utf8")) : undefined,
    };
}

export const x402PayTool: McpX402ToolDef<typeof X402PaySchema> = {
    name: "x402_pay",
    description:
        "Fetch an HTTP resource and, if it returns 402 Payment Required, pay it automatically with x402 and return the paid response. On a 402 it: parses the merchant's price, authorizes via the CryptoAPIs buyer /authorize, signs the payment LOCALLY (non-custodial — the key never leaves this process), and retries with the X-PAYMENT header. Returns { status, paid, body, settlement? }. Supported today: EVM (eip712, e.g. Base USDC) and Solana. Tron, UTXO (bitcoin/ltc/doge/dash/bch/zcash), Kaspa and XRP are UPCOMING — wired but not yet enabled, and paying on them returns a clear coming-soon (family_not_yet_supported) result. Set CRYPTOAPIS_API_KEY + X402_WALLET_ID once, plus the signing key(s) for the chain(s) you pay on: X402_PRIVATE_KEY (EVM hex), X402_SVM_SECRET (base58). A scheme with no configured key errors cleanly (never mis-signs). Env vars keep keys OUT of tool-call logs. Use allowedNetworks to restrict, maxAmount as a safety cap. SECURITY: use only in trusted local environments.",
    inputSchema: X402PaySchema,
    handler: async (input: X402PayInput) => {
        const result = await x402Pay(input);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
};
