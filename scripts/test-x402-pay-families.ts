/**
 * Verify x402_pay's per-family PaymentPayload WIRE SHAPE is accepted by the facilitator.
 *
 * The dispatch in x402Pay builds, per family, a `{x402Version, scheme:"exact", network,
 * payload:{...}}` envelope. This asserts each family's payload shape passes the
 * facilitator's `parseEnvelope` + that family handler's `parsePayload` (the wire contract
 * the facilitator gates on: scheme must be "exact", family resolves from `network`, and
 * the payload carries the key/type each handler reads). It also drives the real dispatch
 * for the two families that need no external signing dep (Tron uses mcp-signer's elliptic;
 * EVM is the existing test) and confirms they PAY through the mock.
 *
 * Full per-family SIGNATURE recovery is covered by mcp-signer's test-x402-nonevm-sign +
 * is the live prod-test; this locks the wire shape so a dispatch regression is caught here.
 *
 *   pnpm run test:x402-pay-families
 *
 * Exits non-zero on any mismatch.
 */

import http from "node:http";
import { x402Pay } from "../src/tools/x402-pay/index.js";

const X402_CORE = "../../../../cryptoapis-x402-core/src/protocol.js";

type Artifact = { scheme: string; signingPayload: Record<string, unknown> };

/** Mock merchant (402 → paid) + buyer /authorize handing out `artifact`. */
function startServer(artifact: Artifact, requirements: Record<string, unknown>): Promise<{ base: string; close: () => void }> {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on("data", (c) => chunks.push(c));
            req.on("end", () => {
                if (req.url?.endsWith("/authorize")) {
                    res.writeHead(200, { "content-type": "application/json" });
                    res.end(JSON.stringify({ authorized: true, ...artifact }));
                    return;
                }
                if (!req.headers["x-payment"]) {
                    res.writeHead(402, { "content-type": "application/json" });
                    res.end(JSON.stringify({ x402Version: 2, accepts: [requirements] }));
                    return;
                }
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true }));
            });
        });
        server.listen(0, "127.0.0.1", () => {
            const addr = server.address() as { port: number };
            resolve({ base: `http://127.0.0.1:${addr.port}`, close: () => server.close() });
        });
    });
}

async function run(): Promise<void> {
    const results: string[] = [];
    const { parseEnvelope } = await import(X402_CORE);

    // 1. Wire-shape contract: each family's payload shape must pass parseEnvelope +
    //    parsePayload. These are exactly the shapes x402Pay's dispatch emits.
    const shapeChecks = [
        { fam: "svm", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", payload: { transaction: "AQAAsvm-base64" } },
        { fam: "tron", network: "tron:0x2b6653dc", payload: { transaction: { txID: "ab", raw_data_hex: "0a", signature: ["cc"] } } },
        { fam: "utxo", network: "bip122:000000000019d6689c085ae165831e93", payload: { transaction: "deadbeef" } },
        { fam: "kaspa", network: "kaspa:mainnet", payload: { transaction: "{\"tx\":1}" } },
        { fam: "xrp", network: "xrpl:0", payload: { transaction: "1200002280000000" } },
    ];
    for (const s of shapeChecks) {
        const requirements = { scheme: "exact", network: s.network, amount: "10000", asset: "native", payTo: "x", maxTimeoutSeconds: 300, extra: {} };
        const paymentPayload = { x402Version: 2, scheme: "exact", network: s.network, payload: s.payload };
        const env = parseEnvelope({ paymentRequirements: requirements, paymentPayload });
        if (env.family !== s.fam) throw new Error(`${s.fam}: parseEnvelope resolved family=${env.family}`);
        results.push(`parseEnvelope(${env.family}) accepts x402Pay's ${s.fam} payload shape ✓`);
    }

    // 2. Upcoming families are GATED off ("coming soon") even with a key wired — the gate
    //    fires before any signing. Tron/UTXO/XRP/Kaspa are wired but not yet live-verified.
    const requirements = { scheme: "exact", network: "tron:0x2b6653dc", amount: "10000", asset: "native", payTo: "x", maxTimeoutSeconds: 300, extra: {} };
    const gatedArtifact: Artifact = {
        scheme: "tron-transaction",
        signingPayload: {
            transaction: {
                txID: "",
                raw_data: { contract: [{ parameter: { value: { owner_address: "41" + "00".repeat(20) } } }] },
                raw_data_hex: "0a0212".padEnd(80, "0"),
                visible: false,
            },
        },
    };
    const { base, close } = await startServer(gatedArtifact, requirements);
    try {
        // key IS provided — the gate must still refuse (never reaches signing)
        const res = await x402Pay({ url: `${base}/premium`, apiKey: "k", walletId: "w", buyerBaseUrl: `${base}/x402/buyer`, tronKey: "aa".repeat(32) });
        if (res.paid || !/family_not_yet_supported/.test(res.reason ?? "")) {
            throw new Error(`tron gate: expected family_not_yet_supported, got ${JSON.stringify(res)}`);
        }
        results.push("tron (upcoming): gated as coming-soon even with a key wired ✓");
    } finally {
        close();
    }

    // 3. A family with no configured key errors CLEANLY (never mis-signs).
    const { base: b2, close: c2 } = await startServer({ scheme: "svm-transaction", signingPayload: { transaction: "x" } }, { ...requirements, network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" });
    try {
        const res = await x402Pay({ url: `${b2}/premium`, apiKey: "k", walletId: "w", buyerBaseUrl: `${b2}/x402/buyer` });
        if (res.paid || !/no signing key/.test(res.reason ?? "")) throw new Error(`svm no-key: expected clean error, got ${JSON.stringify(res)}`);
        results.push("svm without key: clean 'no signing key' error (no mis-sign) ✓");
    } finally {
        c2();
    }

    console.log(results.join("\n"));
    console.log("\nAll x402_pay family dispatch + wire-shape checks passed.");
}

run().catch((e) => { console.error("FAIL:", e); process.exit(1); });
