# @cryptoapis-io/mcp-x402-pay

## 0.5.2

### Patch Changes

- Updated dependencies [3167621]
  - @cryptoapis-io/mcp-shared@0.4.0
  - @cryptoapis-io/mcp-signer@0.4.1

## 0.5.1

### Patch Changes

- 9b37ad7: Send the paid resource (the fetched URL, or the MCP challenge's ResourceInfo) to the buyer `/authorize`. x402 v2 carries no resource inside PaymentRequirements, so wallets with `allowedDomains` were refused `domain_not_allowed` on every v2 merchant.

## 0.5.0

### Minor Changes

- Speak the x402 v2 HTTP transport alongside v1. The payer now reads the challenge from the
  `PAYMENT-REQUIRED` header (falling back to the 402 body), sends the credential on both
  `PAYMENT-SIGNATURE` and `X-PAYMENT`, and reads the settlement receipt from either
  `PAYMENT-RESPONSE` or `X-PAYMENT-RESPONSE`. The PaymentPayload additionally carries the chosen
  requirement as `accepted` (required by v2 §5.2.2) while keeping top-level `scheme`/`network`, so
  merchants matching on either shape pair the payment correctly.

  Previously a merchant implementing the v2 transport — which may send no response body at all —
  could not be paid.

## 0.4.0

### Minor Changes

- e519949: Add `x402_pay_tool` — pay a paid TOOL on another MCP server, not just an HTTP url.

  Closes the last gap in the x402 MCP transport. A merchant could charge for an MCP tool and an agent
  could pay HTTP endpoints, but no agent of ours could pay a TOOL — including a CryptoAPIs merchant's
  own. The loop now closes.

  The authorize → sign → build-payload flow moved to `tools/payCore.ts` and is shared by both payers;
  only the envelope differs (HTTP base64s the payload into `X-PAYMENT`, MCP sends the same object raw
  in `_meta["x402/payment"]`). A payment fix or a newly-enabled family can no longer land on one
  transport only.
