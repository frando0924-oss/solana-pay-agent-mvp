import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPaymentRequest,
  buildSignatureLookupRequest,
  createReconciliationLedger,
  parseSolToLamports,
  verifyPaymentTransaction,
} from "../src/index.mjs";

const recipient = "11111111111111111111111111111111";
const reference = "11111111111111111111111111111111";

test("builds a capped Solana Pay request with a reference", () => {
  const request = buildPaymentRequest({
    recipient,
    reference,
    amountSol: "0.000001",
    label: "Agent MVP",
    memo: "demo payment",
    maxSol: "0.01",
  });

  assert.equal(request.amountLamports, 1000n);
  assert.match(request.uri, /^solana:11111111111111111111111111111111\?/);
  assert.match(request.uri, /reference=11111111111111111111111111111111/);
  assert.match(request.uri, /amount=0.000001/);
});

test("rejects a request above the configured cap", () => {
  assert.throws(
    () => buildPaymentRequest({ recipient, reference, amountSol: "0.010001", maxSol: "0.01" }),
    /exceeds configured cap/,
  );
});

test("uses integer lamports and rejects malformed amounts", () => {
  assert.equal(parseSolToLamports("1.25"), 1_250_000_000n);
  assert.throws(() => parseSolToLamports("1e-6"), /decimal/);
});

test("builds the RPC lookup request without a private key", () => {
  const request = buildSignatureLookupRequest(reference);
  assert.equal(request.method, "getSignaturesForAddress");
  assert.deepEqual(request.params[0], reference);
});

test("accepts a confirmed parsed transfer with the matching reference", () => {
  const result = verifyPaymentTransaction({
    signature: "demo-signature",
    recipient,
    reference,
    expectedLamports: 1000n,
    transaction: {
      meta: { err: null },
      transaction: {
        message: {
          accountKeys: [{ pubkey: recipient }, { pubkey: reference }],
          instructions: [
            {
              program: "system",
              parsed: { type: "transfer", info: { destination: recipient, lamports: 1000 } },
            },
          ],
        },
      },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.receivedLamports, 1000n);
});

test("rejects a failed or unrelated transaction", () => {
  const result = verifyPaymentTransaction({
    recipient,
    reference,
    expectedLamports: 1000n,
    transaction: { meta: { err: { InstructionError: [0, "Custom"] } } },
  });
  assert.deepEqual(result, { ok: false, reason: "transaction failed on-chain" });
});

test("reconciles an order once and makes repeated confirmation idempotent", () => {
  const ledger = createReconciliationLedger({ now: () => 1_000 });
  const order = ledger.registerOrder({
    orderId: "order-1",
    recipient,
    reference,
    expectedLamports: 1000n,
  });
  assert.equal(order.status, "pending");

  const transaction = {
    meta: { err: null },
    transaction: {
      message: {
        accountKeys: [{ pubkey: recipient }, { pubkey: reference }],
        instructions: [
          { program: "system", parsed: { type: "transfer", info: { destination: recipient, lamports: 1000 } } },
        ],
      },
    },
  };
  const paid = ledger.reconcileOrder({ orderId: "order-1", signature: "sig-1", transaction });
  assert.equal(paid.ok, true);
  assert.equal(paid.status, "paid");
  assert.equal(paid.order.receivedLamports, 1000n);

  const replay = ledger.reconcileOrder({ orderId: "order-1", signature: "sig-1", transaction: null });
  assert.deepEqual(replay, { ok: true, replayed: true, order: paid.order });
});

test("prevents a transaction signature from paying a second order", () => {
  const ledger = createReconciliationLedger({ now: () => 1_000 });
  const details = { recipient, reference, expectedLamports: 1000n };
  ledger.registerOrder({ orderId: "order-a", ...details });
  ledger.registerOrder({ orderId: "order-b", ...details, reference: "11111111111111111111111111111112" });
  const transaction = {
    meta: { err: null },
    transaction: {
      message: {
        accountKeys: [{ pubkey: recipient }, { pubkey: reference }],
        instructions: [
          { program: "system", parsed: { type: "transfer", info: { destination: recipient, lamports: 1000 } } },
        ],
      },
    },
  };
  assert.equal(ledger.reconcileOrder({ orderId: "order-a", signature: "sig-reused", transaction }).ok, true);
  const reused = ledger.reconcileOrder({ orderId: "order-b", signature: "sig-reused", transaction });
  assert.equal(reused.ok, false);
  assert.equal(reused.status, "rejected");
});

test("expires an unpaid order and does not accept it afterwards", () => {
  let time = 1_000;
  const ledger = createReconciliationLedger({ now: () => time });
  ledger.registerOrder({ orderId: "expiring", recipient, reference, expectedLamports: 1000n, expiresAt: 2_000 });
  time = 2_000;
  const result = ledger.reconcileOrder({ orderId: "expiring", signature: "late", transaction: null });
  assert.equal(result.ok, false);
  assert.equal(result.status, "expired");
  assert.equal(ledger.getOrder("expiring").status, "expired");
});
