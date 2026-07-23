# @cryptoapis-io/mcp-x402-pay

> **This is the BUYER side of x402** — the tool an agent uses to *spend* (pay for a resource). Merchants
> who want to *charge* for an API use the middleware SDK (`@cryptoapis-io/x402-merchant-sdk`), not an MCP tool.

An MCP server that lets an AI agent **pay x402-gated HTTP endpoints**. One tool, `x402_pay`: it fetches a
URL and, if the server returns `402 Payment Required`, it authorizes the payment via the CryptoAPIs buyer
service, **signs locally**, retries, and returns the paid response.

**Non-custodial:** the private key is passed per request and never leaves the process (no HTTP server —
stdio only).

**Supported today:** EVM (`eip712`, e.g. Base USDC) and Solana. Tron, Bitcoin/UTXO, XRP and Kaspa are
**upcoming** — wired but not yet enabled; paying on them returns a clear `family_not_yet_supported`
("coming soon") result.

## Run

```bash
node dist/cli.js            # stdio MCP server (no --api-key at startup; keys are per-tool-call)
```

## Tool: `x402_pay`

| Input | Required | Description |
|---|---|---|
| `url` | ✓ | the (possibly paywalled) resource |
| `apiKey` | ✓ | your CryptoAPIs key (X402_BUYER feature) — only used to call the buyer `/authorize` |
| `walletId` | ✓ | the agent wallet the buyer service pays from |
| `privateKey` | ✓ | the wallet's EVM key — **signs locally, never sent anywhere** |
| `method`/`body`/`headers` | | the request to make |
| `allowedNetworks` | | restrict which CAIP-2 networks to pay on |
| `maxAmount` | | safety cap — refuse if the required atomic-unit amount exceeds it |

Returns `{ status, paid, body, settlement? }`. On a 402 with no acceptable option (or over `maxAmount`),
`paid:false` with a `reason` — nothing is signed or paid.

## Flow

1. `fetch(url)`. Not 402 → return it.
2. 402 → pick an `accepts` entry (allowlist-aware), authorize via buyer `/authorize` → the signing artifact.
3. Sign locally (`@cryptoapis-io/mcp-signer` `evm_sign` typed-data) → build the x402 `PaymentPayload`
   (**wire scheme is always `exact`**; the family is in `network`).
4. Retry with the base64 `X-PAYMENT` header; return the paid response + the `X-PAYMENT-RESPONSE` settlement.

## Security

The private key is a tool parameter and **may be logged by MCP clients or stored in conversation
history** — use only in trusted local environments. This mirrors `@cryptoapis-io/mcp-signer`.
