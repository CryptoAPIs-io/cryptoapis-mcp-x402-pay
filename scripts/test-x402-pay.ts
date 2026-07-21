/**
 * Verify the x402_pay tool end-to-end (EVM eip712) against a LOCAL mock server that
 * behaves like a merchant (402 → paid) + the buyer /authorize, with a real key. Then
 * confirms the X-PAYMENT the tool built is accepted by the facilitator's parseEnvelope
 * and its signature recovers to the buyer.
 *
 * Self-contained (spins an http server on 127.0.0.1, generates a key). Run:
 *   pnpm run test:x402-pay
 * Exits non-zero on any mismatch.
 */

import http from "node:http";
import { Wallet } from "ethers";
import { x402Pay } from "../src/tools/x402-pay/index.js";

// Sibling x402-core/-evm libs (verify the produced X-PAYMENT the way the facilitator does).
const X402_CORE = "../../../../cryptoapis-x402-core/src/protocol.js";
const X402_EVM = "../../../../cryptoapis-x402-evm/src/eip3009.js";

const wallet = Wallet.createRandom();
const from = wallet.address;
const domain = { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" };
const message = {
    from, to: "0x2222222222222222222222222222222222222222", value: "10000",
    validAfter: "0", validBefore: "9999999999", nonce: "0x" + "44".repeat(32),
};
const requirements = { scheme: "exact", network: "eip155:8453", amount: "10000", asset: domain.verifyingContract, payTo: message.to, maxTimeoutSeconds: 300, extra: {} };
const types = { TransferWithAuthorization: [
    { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] };

let capturedXPayment: string | undefined;

/** A local server: /premium (402 then paid) + /x402/buyer/authorize. */
function startServer(): Promise<{ base: string; close: () => void }> {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on("data", (c) => chunks.push(c));
            req.on("end", () => {
                if (req.url === "/x402/buyer/authorize") {
                    res.writeHead(200, { "content-type": "application/json" });
                    res.end(JSON.stringify({ authorized: true, scheme: "eip712", signingPayload: { domain, types, primaryType: "TransferWithAuthorization", message } }));
                    return;
                }
                // /premium: 402 unless X-PAYMENT present
                const xp = req.headers["x-payment"];
                if (!xp) {
                    res.writeHead(402, { "content-type": "application/json" });
                    res.end(JSON.stringify({ x402Version: 2, accepts: [requirements] }));
                    return;
                }
                capturedXPayment = String(xp);
                res.writeHead(200, { "content-type": "application/json", "x-payment-response": Buffer.from(JSON.stringify({ success: true, transaction: "0xtx" })).toString("base64") });
                res.end(JSON.stringify({ data: "paid resource" }));
            });
        });
        server.listen(0, "127.0.0.1", () => {
            const addr = server.address();
            const port = typeof addr === "object" && addr ? addr.port : 0;
            resolve({ base: `http://127.0.0.1:${port}`, close: () => server.close() });
        });
    });
}

async function main() {
    const { base, close } = await startServer();
    try {
        const result = await x402Pay({
            url: `${base}/premium`,
            apiKey: "test-key",
            walletId: "w1",
            privateKey: wallet.privateKey,
            buyerBaseUrl: `${base}/x402/buyer`,
        });
        console.log("x402_pay → status:", result.status, "| paid:", result.paid, "| settlement.tx:", (result.settlement as { transaction?: string })?.transaction);

        // Verify the produced X-PAYMENT the facilitator way.
        // @ts-expect-error — JS sibling libs, no types.
        const { parseEnvelope } = await import(X402_CORE);
        // @ts-expect-error — JS sibling libs, no types.
        const { verifyAuthorization } = await import(X402_EVM);
        const paymentPayload = JSON.parse(Buffer.from(capturedXPayment!, "base64").toString("utf8"));
        const env = parseEnvelope({ paymentRequirements: requirements, paymentPayload });
        const v = await verifyAuthorization({ authorization: paymentPayload.payload.authorization, signature: paymentPayload.payload.signature, domain });
        console.log("parseEnvelope → family:", env.family, "scheme:", env.scheme, "| verify valid:", v.valid, "recovered==from:", v.recovered === from);

        const ok = result.paid && env.family === "evm" && env.scheme === "exact" && v.valid && v.recovered === from;
        if (ok) { console.log("✅ x402_pay E2E: fetched a 402, paid it, and the X-PAYMENT is facilitator-valid"); process.exit(0); }
        console.error("❌ x402_pay E2E failed"); process.exit(1);
    } finally {
        close();
    }
}

main().catch((err) => { console.error(err); process.exit(1); });
