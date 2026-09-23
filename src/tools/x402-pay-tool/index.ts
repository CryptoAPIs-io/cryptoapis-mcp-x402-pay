import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { X402PayToolInput } from "./schema.js";
import { X402PayToolSchema } from "./schema.js";
import type { McpX402ToolDef } from "../types.js";
import type { PaymentRequirements } from "../payCore.js";
import { buildPaymentForChallenge, resolveSigningKeys } from "../payCore.js";

/** `_meta` key the payment is sent under (x402 v2 MCP transport). */
const PAYMENT_META_KEY = "x402/payment";

/** `_meta` key the settlement receipt comes back under. */
const PAYMENT_RESPONSE_META_KEY = "x402/payment-response";

type ToolResult = {
    isError?: boolean;
    content?: { type: string; text?: string }[];
    structuredContent?: unknown;
    _meta?: Record<string, unknown>;
};

/**
 * Read an x402 `PaymentRequired` challenge out of an MCP tool result.
 *
 * Per the spec a client SHOULD prefer `structuredContent` and fall back to parsing
 * `content[0].text` — servers must send BOTH, but a server that sends only the text form is
 * still payable, and treating it as unpayable would strand the user.
 *
 * @param result an MCP tool result
 * @return the PaymentRequired body, or null when this is not a payment challenge
 */
export function parseToolChallenge(result: ToolResult | undefined): { accepts?: PaymentRequirements[]; resource?: string | { url?: string } } | null {
    if (!result?.isError) return null;

    const isChallenge = (o: unknown): o is { x402Version: number; accepts: PaymentRequirements[] } =>
        !!o && typeof o === "object"
        && (o as Record<string, unknown>).x402Version !== undefined
        && Array.isArray((o as Record<string, unknown>).accepts);

    if (isChallenge(result.structuredContent)) return result.structuredContent;

    const text = result.content?.[0]?.text;
    if (typeof text === "string") {
        try {
            const parsed: unknown = JSON.parse(text);
            if (isChallenge(parsed)) return parsed;
        } catch {
            return null; // not JSON — an ordinary tool error, not a payment challenge
        }
    }
    return null;
}

/**
 * Call a tool on another MCP server, paying it if it answers with an x402 challenge.
 *
 * The authorize → sign → build-payload half is SHARED with `x402_pay` (`payCore`); only the
 * envelope differs. Over MCP the payment travels as a RAW OBJECT in `_meta["x402/payment"]` —
 * no base64, because MCP carries structured JSON natively.
 *
 * @param input the tool input
 * @return the tool result, plus whether a payment was made
 */
export async function x402PayTool(input: X402PayToolInput): Promise<{
    paid: boolean; result?: unknown; settlement?: unknown; reason?: string;
}> {
    const apiKey = input.apiKey ?? process.env.CRYPTOAPIS_API_KEY;
    const walletId = input.walletId ?? process.env.X402_WALLET_ID;
    if (!apiKey || !walletId) {
        const missing = [!apiKey && "apiKey/CRYPTOAPIS_API_KEY", !walletId && "walletId/X402_WALLET_ID"].filter(Boolean).join(", ");
        return { paid: false, reason: `missing credentials: ${missing} (pass as params or set the env vars)` };
    }

    const client = new Client({ name: "mcp-x402-pay", version: "0.4.0" }, { capabilities: {} });
    const transport = new StdioClientTransport({
        command: input.server.command,
        args: input.server.args ?? [],
        env: { ...(process.env as Record<string, string>), ...(input.server.env ?? {}) },
    });

    try {
        await client.connect(transport);

        const params = { name: input.toolName, arguments: input.arguments ?? {} };
        const first = await client.callTool(params) as ToolResult;

        const challenge = parseToolChallenge(first);
        if (!challenge) {
            // Not a payment challenge (success, or an ordinary tool error) — hand it back
            // untouched rather than interpreting someone else's error.
            return { paid: false, result: first };
        }

        const built = await buildPaymentForChallenge({
            accepts: Array.isArray(challenge.accepts) ? challenge.accepts : [],
            apiKey: apiKey,
            walletId: walletId,
            keys: resolveSigningKeys(input),
            allowedNetworks: input.allowedNetworks,
            maxAmount: input.maxAmount,
            buyerBaseUrl: input.buyerBaseUrl,
            resource: challenge.resource,
        });
        if (!built.ok) {
            // Return the original challenge alongside the reason so the agent can see the price.
            return { paid: false, reason: built.reason, result: first };
        }

        // Exactly ONE retry, never a loop: a second challenge means the payment was rejected,
        // and re-paying would risk paying twice for one call.
        const paidResult = await client.callTool({
            ...params,
            _meta: { [PAYMENT_META_KEY]: built.paymentPayload },
        }) as ToolResult;

        return {
            paid: !paidResult?.isError,
            result: paidResult,
            settlement: paidResult?._meta?.[PAYMENT_RESPONSE_META_KEY],
        };
    } catch (err) {
        return { paid: false, reason: `upstream MCP call failed: ${err instanceof Error ? err.message : String(err)}` };
    } finally {
        await client.close().catch(() => {});
    }
}

export const x402PayToolDef: McpX402ToolDef<typeof X402PayToolSchema> = {
    name: "x402_pay_tool",
    description:
        "Call a TOOL on another MCP server and, if that tool requires payment, pay it automatically with x402 and return the paid result. This is the MCP-transport twin of x402_pay: use x402_pay for an HTTP url, and THIS for a paid tool on another MCP server. On a challenge it reads the PaymentRequired (from structuredContent, falling back to content[0].text), authorizes via the CryptoAPIs buyer /authorize, signs LOCALLY (non-custodial — the key never leaves this process), and retries the tool call once with the payment in _meta[\"x402/payment\"] (a raw object, no base64 — MCP carries structured JSON natively). Returns { paid, result, settlement? }; the settlement receipt comes back in _meta[\"x402/payment-response\"]. The upstream server is launched over stdio for the call and shut down afterwards. Same credentials and keys as x402_pay: CRYPTOAPIS_API_KEY + X402_WALLET_ID, plus X402_PRIVATE_KEY (EVM) / X402_SVM_SECRET (Solana). Supported today: EVM (eip712) and Solana; Tron, UTXO, Kaspa and XRP return a clear coming-soon result. Use allowedNetworks and maxAmount as guardrails. SECURITY: this tool holds spending keys and launches the process you name — use only in trusted local environments.",
    inputSchema: X402PayToolSchema,
    handler: async (input: X402PayToolInput) => {
        const result = await x402PayTool(input);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
};
