/**
 * Verify the `payment-identifier` extension end-to-end against a LOCAL mock
 * merchant + buyer /authorize, exercising the real x402Pay path.
 *
 * Four properties, and the last two are the ones that actually matter:
 *
 *   1. The extension is present on every payment.
 *   2. A caller-supplied `paymentId` wins over the derived one.
 *   3. Retrying the SAME offer derives the SAME id — otherwise a retry after a
 *      dropped response settles twice, which is the bug this closes.
 *   4. A DIFFERENT offer derives a DIFFERENT id. This is the half people miss:
 *      an id that collapses two genuinely distinct purchases is worse than no
 *      id at all, because a double settle is visible and refundable while a
 *      swallowed purchase looks like success and nobody investigates. Same
 *      resource, same price, same wallet, but a different payee, network or
 *      asset must not share a dedup key.
 */
import http from "node:http";
import { Wallet } from "ethers";
import { x402Pay } from "../src/tools/x402-pay/index.js";

const wallet = Wallet.createRandom();
const from = wallet.address;
const domain = {
    name: "USD Coin", version: "2", chainId: 8453,
    verifyingContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
};
const baseMessage = {
    from, to: "0x2222222222222222222222222222222222222222", value: "10000",
    validAfter: "0", validBefore: "9999999999", nonce: "0x" + "44".repeat(32),
};
const types = {
    TransferWithAuthorization: [
        { name: "from", type: "address" }, { name: "to", type: "address" },
        { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
    ],
};

const BASE_OFFER = {
    scheme: "exact", network: "eip155:8453", amount: "10000",
    asset: domain.verifyingContract, payTo: baseMessage.to,
    maxTimeoutSeconds: 300, extra: {},
};

let offer = { ...BASE_OFFER };
let capturedXPayment: string | undefined;

function startServer(): Promise<{ base: string; close: () => void }> {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on("data", (c) => chunks.push(c));
            req.on("end", () => {
                if (req.url === "/x402/buyer/authorize") {
                    res.writeHead(200, { "content-type": "application/json" });
                    res.end(JSON.stringify({
                        authorized: true, scheme: "eip712",
                        signingPayload: { domain, types, primaryType: "TransferWithAuthorization", message: baseMessage },
                    }));
                    return;
                }
                const xp = req.headers["x-payment"];
                if (!xp) {
                    res.writeHead(402, { "content-type": "application/json" });
                    res.end(JSON.stringify({ x402Version: 2, accepts: [offer] }));
                    return;
                }
                capturedXPayment = String(xp);
                res.writeHead(200, {
                    "content-type": "application/json",
                    "x-payment-response": Buffer.from(JSON.stringify({ success: true, transaction: "0xtx" })).toString("base64"),
                });
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

/** Run one payment and return the payment-identifier the tool actually sent. */
async function payAndReadId(base: string, extra: Record<string, unknown> = {}): Promise<string | undefined> {
    capturedXPayment = undefined;
    const result = await x402Pay({
        url: `${base}/premium`,
        apiKey: "test-key",
        walletId: "w1",
        privateKey: wallet.privateKey,
        buyerBaseUrl: `${base}/x402/buyer`,
        ...extra,
    } as Parameters<typeof x402Pay>[0]);
    if (!result.paid) throw new Error(`payment did not complete: ${JSON.stringify(result)}`);
    if (!capturedXPayment) throw new Error("merchant never received an X-PAYMENT header");
    const envelope = JSON.parse(Buffer.from(capturedXPayment, "base64").toString("utf8"));
    return envelope?.extensions?.["payment-identifier"]?.info?.id;
}

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
    if (!ok) failures++;
}

async function main() {
    const { base, close } = await startServer();
    try {
        offer = { ...BASE_OFFER };
        const first = await payAndReadId(base);
        check("the payment carries a payment-identifier", typeof first === "string" && first.length >= 16 && first.length <= 128, String(first));

        const second = await payAndReadId(base);
        check("retrying the SAME offer derives the SAME id", first === second);

        const supplied = "job_" + "a".repeat(24);
        const explicit = await payAndReadId(base, { paymentId: supplied });
        check("a caller-supplied paymentId takes precedence", explicit === supplied, String(explicit));

        // Each of these is a genuinely different payment for the same resource
        // at the same price. None may share a dedup key with the original.
        const variants: Array<[string, Record<string, unknown>]> = [
            ["a different payee (payTo)", { payTo: "0x3333333333333333333333333333333333333333" }],
            ["a different network", { network: "eip155:1" }],
            ["a different asset", { asset: "0x4444444444444444444444444444444444444444" }],
            ["a different amount", { amount: "20000" }],
        ];
        for (const [label, patch] of variants) {
            offer = { ...BASE_OFFER, ...patch };
            const id = await payAndReadId(base);
            check(`${label} derives a DIFFERENT id`, id !== first, `${String(id).slice(0, 16)}…`);
        }
    } finally {
        close();
    }

    if (failures) {
        console.error(`\n${failures} check(s) failed`);
        process.exit(1);
    }
    console.log("\npayment-identifier: all checks passed");
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
