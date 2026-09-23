/**
 * E2E for `x402_pay_tool`: the buyer half of the x402 MCP transport.
 *
 * Proves the loop BL-0160 said was broken actually closes — an agent using our MCP server can
 * now pay a paid TOOL on someone else's MCP server, not just an HTTP url.
 *
 * Three real processes, no network and no money:
 *   this script (buyer)  →  x402PayTool()  →  a fixture merchant MCP server (stdio child)
 * plus a local mock buyer `/authorize` so the signing path runs with a real key.
 *
 * The fixture merchant emits the challenge BY HAND (not via our merchant SDK) on purpose: it
 * pins the SPEC's wire shape, so this test fails if we drift — rather than passing because both
 * halves happen to share one implementation's idea of the format.
 */

import { createServer } from "node:http";
import { writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Wallet } from "ethers";
import { x402PayTool, parseToolChallenge } from "../src/tools/x402-pay-tool/index.js";

const BUYER = Wallet.createRandom();
const NETWORK = "eip155:8453";
const ASSET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAY_TO = "0x6198000000000000000000000000000000005A6e";

/** A minimal merchant MCP server that charges for one tool.
 *  Written INSIDE the package (not a temp dir) so node resolves its node_modules. */
function writeFixtureMerchant(): string {
    const path = join(dirname(fileURLToPath(import.meta.url)), ".fixture-merchant.mjs");
    writeFileSync(path, `
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const CHALLENGE = {
  x402Version: 2,
  resource: { url: "mcp://tool/premium_data" },
  accepts: [{ scheme: "exact", network: ${JSON.stringify(NETWORK)}, amount: "10000",
              asset: ${JSON.stringify(ASSET)}, payTo: ${JSON.stringify(PAY_TO)}, maxTimeoutSeconds: 300, extra: {} }],
  error: "payment required",
};

const server = new McpServer({ name: "fixture-merchant", version: "1.0.0" });
server.registerTool("premium_data",
  { description: "Paid tool", inputSchema: { query: z.string() } },
  async (args, extra) => {
    const payment = extra?._meta?.["x402/payment"];
    if (!payment) {
      // Spec: the challenge goes in BOTH structuredContent and content[0].text.
      return { isError: true, structuredContent: CHALLENGE,
               content: [{ type: "text", text: JSON.stringify(CHALLENGE) }] };
    }
    // Echo back what we received so the test can assert the wire shape.
    return {
      content: [{ type: "text", text: "secret answer for " + args.query }],
      _meta: { "x402/payment-response": { success: true, transaction: "0xtx", network: payment.network,
               receivedScheme: payment.scheme, hasSignature: !!payment.payload?.signature } },
    };
  });
await server.connect(new StdioServerTransport());
`.trim());
    return path;
}

async function main(): Promise<void> {
    // --- mock buyer /authorize: returns the EIP-712 typed data to sign -----------------------
    const authorize = createServer((req, res) => {
        let body = "";
        req.on("data", (c) => { body += c; });
        req.on("end", () => {
            const { paymentRequirements } = JSON.parse(body || "{}");
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({
                authorized: true,
                scheme: "eip712",
                signingPayload: {
                    domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: paymentRequirements.asset },
                    types: { TransferWithAuthorization: [
                        { name: "from", type: "address" }, { name: "to", type: "address" },
                        { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" },
                        { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
                    ] },
                    primaryType: "TransferWithAuthorization",
                    message: {
                        from: BUYER.address, to: paymentRequirements.payTo, value: paymentRequirements.amount,
                        validAfter: "0", validBefore: String(Math.floor(Date.now() / 1000) + 600),
                        nonce: "0x" + "11".repeat(32),
                    },
                },
            }));
        });
    });
    await new Promise<void>((r) => authorize.listen(0, "127.0.0.1", r));
    const buyerBaseUrl = `http://127.0.0.1:${(authorize.address() as { port: number }).port}`;

    const merchant = writeFixtureMerchant();

    let failures = 0;
    const check = (name: string, ok: boolean, detail = ""): void => {
        console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
        if (!ok) failures++;
    };

    // --- 1. the paid path -------------------------------------------------------------------
    const paid = await x402PayTool({
        server: { command: process.execPath, args: [merchant] },
        toolName: "premium_data",
        arguments: { query: "gold" },
        apiKey: "test-key", walletId: "test-wallet",
        privateKey: BUYER.privateKey,
        buyerBaseUrl,
    });

    check("an unpaid tool call is challenged, paid, and retried", paid.paid === true, `paid=${paid.paid} reason=${paid.reason ?? "-"}`);
    const s = paid.settlement as Record<string, unknown> | undefined;
    check("settlement receipt read from _meta['x402/payment-response']", !!s?.success);
    check("wire scheme is 'exact' (family carried by network)", s?.receivedScheme === "exact", String(s?.receivedScheme));
    check("payment arrived as a RAW OBJECT with a real signature", s?.hasSignature === true);
    check("network round-tripped", s?.network === NETWORK, String(s?.network));
    const text = (paid.result as { content?: { text?: string }[] })?.content?.[0]?.text;
    check("the merchant's real result came back", text === "secret answer for gold", String(text));

    // --- 2. guardrail: maxAmount refuses BEFORE signing --------------------------------------
    const capped = await x402PayTool({
        server: { command: process.execPath, args: [merchant] },
        toolName: "premium_data", arguments: { query: "gold" },
        apiKey: "test-key", walletId: "test-wallet", privateKey: BUYER.privateKey,
        buyerBaseUrl, maxAmount: "1",
    });
    check("maxAmount cap refuses an over-price tool", capped.paid === false && /exceeds maxAmount/.test(capped.reason ?? ""), capped.reason ?? "");

    // --- 3. a non-payment error passes through untouched --------------------------------------
    const challengeOfPlainError = parseToolChallenge({ isError: true, content: [{ type: "text", text: "boom" }] });
    check("an ordinary tool error is NOT mistaken for a challenge", challengeOfPlainError === null);

    // --- 4. text-only servers are still payable (spec fallback) ------------------------------
    const textOnly = parseToolChallenge({
        isError: true,
        content: [{ type: "text", text: JSON.stringify({ x402Version: 2, accepts: [] }) }],
    });
    check("a text-only challenge is parsed (structuredContent fallback)", textOnly !== null);

    authorize.close();
    unlinkSync(merchant);
    console.log(failures === 0 ? "\n✅ x402_pay_tool E2E: an agent can pay another server's TOOL" : `\n❌ ${failures} check(s) failed`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
