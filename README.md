# Solana Pay Agent MVP

Small, keyless proof of concept for an agent workflow:

1. Generate a Solana Pay request with a unique reference.
2. Enforce a configurable maximum amount before showing the request.
3. Verify a confirmed parsed transfer through a Solana JSON-RPC endpoint.

The MVP never stores or asks for a private key and never submits a transaction. It only creates a payment request and verifies what the chain reports. The default demo cap is `0.01 SOL`; change it in the caller only after adding an appropriate product-level policy.

The Node module also exposes `createReconciliationLedger()`, a small storage-agnostic layer for registering orders and reconciling confirmed transfers exactly once. It rejects reuse of a transaction signature across orders and expires unpaid requests at the configured timestamp; persist the returned order records in a real database for production use.

## Run

```text
npm test
npm run demo -- 11111111111111111111111111111111 0.000001 "demo payment"
```

The CLI prints a `solana:` URI and a generated reference. A production adapter should display the URI as a QR code, then call `verifyPaymentWithRpc` using a server-side RPC URL and the reference returned by `buildPaymentRequest`.

## Live demo

Try the browser MVP at <https://frando0924-oss.github.io/solana-pay-agent-mvp/>.
It runs without a build step and keeps the same keyless boundary as the Node
implementation: request creation is unsigned, and verification reads only the
confirmed transaction fields needed to reconcile a payment.

## Safety notes

- Amounts are parsed as integer lamports, avoiding floating-point accounting.
- The recipient and reference must decode to 32-byte Solana public keys.
- Verification requires a successful transaction, the exact reference in the account keys, and at least the requested transfer amount to the configured recipient.
- The in-memory ledger demonstrates idempotency and replay protection; a real product still needs durable storage, webhook/API authentication, and a clear refund policy.

## ZeroClaw showcase pack

This repository also contains a stock-ZeroClaw skill for a keyless Solana Pay
invoice terminal:

- [`skills/solana-pay-terminal/SKILL.md`](skills/solana-pay-terminal/SKILL.md)

The skill keeps the agent at custody tier T0/T1: it can create a capped payment
request and verify a confirmed payment, but it cannot hold keys, sign, broadcast,
refund, or choose a destination from untrusted chat text. The operator supplies
the recipient and RPC endpoint in local configuration, and the human remains the
approval gate for any money-moving action.
