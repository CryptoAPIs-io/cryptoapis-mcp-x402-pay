# @cryptoapis-io/mcp-x402-pay

> **This is the BUYER side of x402** — the tool an agent uses to *spend* (pay for a resource). Merchants
> who want to *charge* for an API use the middleware SDK (`@cryptoapis-io/x402-merchant-sdk`), not an MCP tool.

An MCP server that lets an AI agent **find and pay** x402-gated HTTP endpoints.

- **`x402_pay`** — fetches a URL and, if the server returns `402 Payment Required`, authorizes the payment
  via the CryptoAPIs buyer service, **signs locally**, retries, and returns the paid response.
- **`x402_discover`** — browses the facilitator's catalogue of x402 resources and their prices, so an agent
  can *find* a paid API instead of only calling one it was handed.

**Non-custodial:** the private key is passed per request and never leaves the process (no HTTP server —
stdio only).

**Supported today:** EVM (`eip712`, e.g. Base USDC) and Solana. Tron, Bitcoin/UTXO, XRP and Kaspa are
**upcoming** — wired but not yet enabled; paying on them returns a clear `family_not_yet_supported`
("coming soon") result.

## Run

```bash
node dist/cli.js            # stdio MCP server (no --api-key at startup; keys are per-tool-call)
```

## Prerequisite — an agent `walletId`

`x402_pay` pays from a CryptoAPIs **agent wallet** (`walletId`). Create one ONCE per blockchain+network
before paying — a single `POST` to the buyer API returns the id (non-custodial: you register only your
PUBLIC address):

```bash
curl -X POST https://ai.cryptoapis.io/x402/buyer/wallets \
  -H "x-api-key: $CRYPTOAPIS_API_KEY" -H "content-type: application/json" \
  -d '{"blockchain":"base","network":"eip155:8453","address":"0xYourAddress"}'
# → { "walletId": "…" }
```

`network` MUST be the **CAIP-2 id** (`eip155:8453`, `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`, …), not a
bare name — and exactly one of `address` (any chain; **required for Solana/Kaspa**) or `xpub`
(xpub-capable chains). A malformed body returns a clear `400 malformed_request`. Set the returned id as
`X402_WALLET_ID` (or pass `walletId`).

## Tool: `x402_pay`

| Input | Required | Description |
|---|---|---|
| `url` | ✓ | the (possibly paywalled) resource |
| `apiKey` | ✓ | your CryptoAPIs key (X402_BUYER feature) — only used to call the buyer `/authorize` |
| `walletId` | ✓ | the **wallet record id** from `POST /wallets` (a registry `_id`) — **NOT the on-chain address** (an address gets `wallet_not_found`) |
| `privateKey` | ✓ | the wallet's EVM key — **signs locally, never sent anywhere** |
| `method`/`body`/`headers` | | the request to make |
| `allowedNetworks` | | restrict which CAIP-2 networks to pay on |
| `maxAmount` | | safety cap — refuse if the required atomic-unit amount exceeds it |
| `allowedHosts` | | restrict WHICH SITES may be paid, e.g. `["api.acme.com"]` (leading dot = subdomains). A url outside the list is refused **before any network call**. Falls back to `X402_ALLOWED_HOSTS` (comma-separated) — pin it there to keep the allowlist **outside the model's reach** |

Returns `{ status, paid, body, settlement? }`. On a 402 with no acceptable option (or over `maxAmount`),
`paid:false` with a `reason` — nothing is signed or paid.

## Tool: `x402_discover`

Browse the x402 "Bazaar" — the registered x402 resources and what each charges
([spec §8](https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md)).

| Input | Required | Description |
|---|---|---|
| `type` | | filter by resource type, e.g. `"http"` |
| `limit` | | page size, 1–100 (default 20) |
| `offset` | | rows to skip, for paging (default 0) |
| `facilitatorBaseUrl` | | override the facilitator (QA/local) |

Returns `{ resources: [{ resource, type, x402Version, accepts, lastUpdated, metadata? }], pagination }`.

**Public — no API key, no wallet, spends nothing**, so it is always safe to call. Note `accepts[].amount`
is in **atomic units** (USDC 6-decimals: `"10000"` = $0.01) — convert before quoting a price to a user.
Pass a chosen `resource` to `x402_pay` to actually buy it.

## Flow

1. `fetch(url)`. Not 402 → return it.
2. 402 → pick an `accepts` entry (allowlist-aware), authorize via buyer `/authorize` → the signing artifact.
3. Sign locally (`@cryptoapis-io/mcp-signer` `evm_sign` typed-data) → build the x402 `PaymentPayload`
   (**wire scheme is always `exact`**; the family is in `network`).
4. Retry with the base64 `X-PAYMENT` header; return the paid response + the `X-PAYMENT-RESPONSE` settlement.

## Security

The private key is a tool parameter and **may be logged by MCP clients or stored in conversation
history** — use only in trusted local environments. This mirrors `@cryptoapis-io/mcp-signer`.
