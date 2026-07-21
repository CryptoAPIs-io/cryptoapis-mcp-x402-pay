# CLAUDE.md — @cryptoapis-io/mcp-x402-pay

MCP server with one tool, **`x402_pay`**: fetch an HTTP resource and, on a `402 Payment Required`,
auto-pay it with x402 (authorize → sign locally → retry) and return the paid response. The **agentic
buyer surface** — an AI agent calls `x402_pay(url, apiKey, walletId, privateKey)` and paywalled endpoints
just work. Sibling of `mcp-signer` (which it depends on for local signing) and the buyer SDK
(`cryptoapis-x402-buyer-sdk`, whose orchestration this mirrors inside the monorepo).

## Non-custodial + local-only
Like `mcp-signer`: **stdio transport only, no HTTP server, no startup api-key.** The buyer's private key
is a per-call tool parameter, signs LOCALLY, and never leaves the process. `apiKey` (the X402_BUYER key)
is used ONLY to call the buyer `/authorize` — never to sign.

## The flow (`src/tools/x402-pay/index.ts`)
1. `fetch(url, {method, body, headers})`. Not 402 → return it.
2. 402 → parse `accepts`, pick one (`allowedNetworks`-aware), enforce `maxAmount` cap.
3. POST it to the buyer `/authorize` (`apiKey` + `walletId`) → `{ authorized, scheme, signingPayload }`.
4. Sign by the **artifact scheme**, calling the matching `@cryptoapis-io/mcp-signer` function with the
   per-family key (all six wired): `eip712`→`evmSignTypedData`, `svm-transaction`→`svmPartialSign`,
   `tron-transaction`→`tronSignFromDetails`, `utxo-transaction`→`utxoSignFromDetails`,
   `kaspa-transaction`→`kaspaSignFromDetails`, `xrp-transaction`→`xrpSignFromDetails`.
5. Build the `PaymentPayload` — **wire `scheme` is ALWAYS `exact`** (the facilitator's `parseEnvelope`
   rejects anything else; the family comes from `network`). The `/authorize` scheme is the artifact type,
   NOT the wire scheme. Every family's `parsePayload` reads `payload.transaction` first, so the wrapper is
   uniform `payload:{transaction: <value>}` — **but the VALUE differs per family**: EVM `{signature,
   authorization}`; SVM base64; UTXO/XRP signed hex; Kaspa signed JSON; **Tron the structured
   `{txID, raw_data_hex, raw_data, signature[]}` object** (the facilitator rejects a bare hex — hence
   mcp-signer's `tronSignFromDetails` additively returns `signedTransaction`). Base64 → `X-PAYMENT`
   header, retry once, return `{status, paid, body, settlement?}`.

## Per-family signing keys (each chain signs with ITS OWN key form)
A single hex key can't sign a Solana/UTXO/XRP payment, so each family takes its own optional key/env
(param → family env → EVM fallback where the curve allows). Set only the ones you pay on:
`X402_PRIVATE_KEY` (EVM hex; Tron default), `X402_TRON_KEY` (hex), `X402_SVM_SECRET` (base58),
`X402_UTXO_WIF` (WIF), `X402_KASPA_KEY` (hex), `X402_XRP_SEED` (seed). A scheme whose key isn't
configured returns a clean `no signing key for <scheme>` error — it never mis-signs. UTXO also needs the
`{blockchain, network}` pair, derived from the CAIP-2 network via `UTXO_CAIP2` in `index.ts`.

## Structure (mirrors mcp-signer, the keyless-local pattern)
`src/cli.ts` (stdio boot) → `server.ts` (registers tools, stdio only) → `tools/x402-pay/{schema,index}.ts`.
`index.ts` barrel exports `x402Pay` (the pure function, for tests) + `startX402Server` + `tools`.
Depends on `@cryptoapis-io/mcp-signer` (workspace, signing) + `@cryptoapis-io/mcp-shared` (logger) + `ethers` + `zod`.

## Verified
`scripts/test-x402-pay.ts` (`pnpm run test:x402-pay`) spins a local mock merchant (402→paid) + buyer
`/authorize`, runs `x402Pay` with a real key, and asserts the produced `X-PAYMENT` is accepted by the
facilitator's `parseEnvelope` (family=evm, scheme=exact, network match) AND its signature recovers to the
buyer. The full agent→pay→resource loop works.

## Verified — all families
`scripts/test-x402-pay-families.ts` (`pnpm run test:x402-pay-families`) asserts each family's produced
`PaymentPayload` passes the facilitator's `parseEnvelope` + handler `parsePayload` (the wire contract),
drives the full Tron dispatch (authorize → sign → structured object → pay) end-to-end, and confirms a
missing per-family key errors cleanly. Full per-family SIGNATURE recovery is covered by mcp-signer's
`test-x402-nonevm-sign` and is the live prod-test.

## Status
All six families wired (EVM/SVM/Tron/UTXO/Kaspa/XRP). Depends on `mcp-signer`'s per-family signers —
including its **additive** Tron structured-output change (`tronSignFromDetails` now also returns
`signedTransaction`). Registry metadata in `server.json` (`mcpName` matches). **NOT published —
branch-only (`investigate/utxo-signer-per-chain`) until prod-tested**, like the signer changes it
depends on. Live signature-recovery per family is the remaining prod-test step.
