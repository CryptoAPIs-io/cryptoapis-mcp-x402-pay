import type { X402PayInput } from "./schema.js";
import { X402PaySchema } from "./schema.js";
import type { McpX402ToolDef } from "../types.js";
import type { PaymentRequirements } from "../payCore.js";
import { buildPaymentForChallenge, resolveSigningKeys } from "../payCore.js";

/**
 * Is `url` allowed by a host allowlist?
 *
 * An entry matches the host exactly; an entry with a LEADING DOT (`.acme.com`) also matches
 * any subdomain. Matching is on the parsed hostname, never on substrings of the raw url —
 * a substring test would let `evil.com/?x=api.acme.com` through.
 *
 * @param url the url about to be fetched
 * @param allowed the allowlist (already resolved from param or env)
 * @return true when the url may be paid
 */
export function isHostAllowed(url: string, allowed: string[]): boolean {
    let host: string;
    try {
        host = new URL(url).hostname.toLowerCase();
    } catch {
        return false; // unparseable url is never allowed
    }
    return allowed.some((entry) => {
        const e = entry.trim().toLowerCase();
        if (!e) return false;
        return e.startsWith(".") ? host === e.slice(1) || host.endsWith(e) : host === e;
    });
}

/**
 * Decode the base64 `PAYMENT-REQUIRED` header into the x402 v2 PaymentRequired challenge.
 * Null when absent or malformed, so the v1 body fallback still applies.
 *
 * @param headerValue the raw header value
 * @return the decoded challenge, or null
 */
function decodePaymentRequired(headerValue: string | null): { accepts?: PaymentRequirements[] } | null {
    if (!headerValue) return null;
    try {
        return JSON.parse(Buffer.from(headerValue, "base64").toString("utf8"));
    } catch {
        return null;
    }
}

/**
 * Fetch a URL and auto-pay a 402 with x402.
 *
 * The authorize → sign → build-payload half lives in `payCore` and is SHARED with the
 * MCP-tool payer (`x402_pay_tool`); only the HTTP envelope is here — the 402 status, the
 * base64 `X-PAYMENT` header, and the `X-PAYMENT-RESPONSE` receipt.
 *
 * @param input the tool input
 * @return the final (paid) response summary
 */
export async function x402Pay(input: X402PayInput): Promise<{
    status: number; paid: boolean; body: string; settlement?: unknown; reason?: string;
}> {
    // Host allowlist FIRST — before credentials, before any fetch. This tool holds spending
    // keys and will pay whatever url it is handed, so a url the operator never sanctioned
    // must not even be contacted. Resolved from the param OR X402_ALLOWED_HOSTS so an
    // operator can pin it outside the model's reach; unset = unrestricted (x402 is an open
    // protocol and the tool must be able to pay any merchant, incl. our own customers).
    const allowedHosts = input.allowedHosts
        ?? (process.env.X402_ALLOWED_HOSTS ? process.env.X402_ALLOWED_HOSTS.split(",") : undefined);
    if (allowedHosts && allowedHosts.length > 0 && !isHostAllowed(input.url, allowedHosts)) {
        return {
            status: 0,
            paid: false,
            reason: `host not allowed: ${input.url} is outside allowedHosts (${allowedHosts.join(", ")})`,
            body: "",
        };
    }

    // Credentials: prefer the per-call params, else fall back to env (set once in the
    // MCP config so the agent only ever passes `url` — and the key stays out of logs).
    const apiKey = input.apiKey ?? process.env.CRYPTOAPIS_API_KEY;
    const walletId = input.walletId ?? process.env.X402_WALLET_ID;
    if (!apiKey || !walletId) {
        const missing = [!apiKey && "apiKey/CRYPTOAPIS_API_KEY", !walletId && "walletId/X402_WALLET_ID"].filter(Boolean).join(", ");
        return { status: 0, paid: false, reason: `missing credentials: ${missing} (pass as params or set the env vars)`, body: "" };
    }

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

    // x402 v2 carries the challenge in the PAYMENT-REQUIRED header and treats the response
    // body as a server implementation concern (a conforming merchant may send no body at
    // all); v1 put it in the body. Read the header first, fall back to the body.
    const body402 = await first.json().catch(() => null) as { accepts?: PaymentRequirements[] } | null;
    const fromHeader = decodePaymentRequired(first.headers.get("payment-required"));
    const built = await buildPaymentForChallenge({
        accepts: Array.isArray(fromHeader?.accepts) && fromHeader.accepts.length > 0
            ? fromHeader.accepts
            : (Array.isArray(body402?.accepts) ? body402.accepts : []),
        apiKey: apiKey,
        walletId: walletId,
        keys: resolveSigningKeys(input),
        allowedNetworks: input.allowedNetworks,
        maxAmount: input.maxAmount,
        buyerBaseUrl: input.buyerBaseUrl,
        // The URL actually fetched — not the merchant's self-declared resource.
        resource: input.url,
    });
    if (!built.ok) {
        return { status: 402, paid: false, reason: built.reason, body: JSON.stringify(body402 ?? {}) };
    }

    // Retry the ORIGINAL request with the X-PAYMENT header. HTTP carries the payload as a
    // base64 header value; MCP carries the same object as structured JSON (see x402_pay_tool).
    const credential = Buffer.from(JSON.stringify(built.paymentPayload), "utf8").toString("base64");
    const paid = await fetch(input.url, {
        ...baseInit,
        // Both header names carry the SAME value: PAYMENT-SIGNATURE for a v2 merchant,
        // X-PAYMENT for a v1 one. Each reads the one it knows and ignores the other.
        headers: {
            ...(baseInit.headers as Record<string, string>),
            "payment-signature": credential,
            "x-payment": credential,
        },
    });
    const paymentResponse = paid.headers.get("payment-response") ?? paid.headers.get("x-payment-response");
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
        "Fetch an HTTP resource and, if it returns 402 Payment Required, pay it automatically with x402 and return the paid response. On a 402 it: parses the merchant's price, authorizes via the CryptoAPIs buyer /authorize, signs the payment LOCALLY (non-custodial — the key never leaves this process), and retries with the X-PAYMENT header. Returns { status, paid, body, settlement? }. This is for HTTP URLs — to pay a paid MCP TOOL on another server, use x402_pay_tool instead. Supported today: EVM (eip712, e.g. Base USDC) and Solana. Tron, UTXO (bitcoin/ltc/doge/dash/bch/zcash), Kaspa and XRP are UPCOMING — wired but not yet enabled, and paying on them returns a clear coming-soon (family_not_yet_supported) result. Set CRYPTOAPIS_API_KEY + X402_WALLET_ID once, plus the signing key(s) for the chain(s) you pay on: X402_PRIVATE_KEY (EVM hex), X402_SVM_SECRET (base58). A scheme with no configured key errors cleanly (never mis-signs). Env vars keep keys OUT of tool-call logs. Use allowedNetworks to restrict chains, maxAmount as a per-call spend cap, and allowedHosts to restrict WHICH SITES may be paid (a url outside the list is refused before any network call; set X402_ALLOWED_HOSTS in the MCP config to pin it outside the model's reach). SECURITY: this tool holds spending keys — use only in trusted local environments, and prefer pinning allowedHosts + maxAmount via env for unattended runs.",
    inputSchema: X402PaySchema,
    handler: async (input: X402PayInput) => {
        const result = await x402Pay(input);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
};
