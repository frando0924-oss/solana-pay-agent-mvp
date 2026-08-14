import { randomBytes } from "node:crypto";

export const LAMPORTS_PER_SOL = 1_000_000_000n;
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_INDEX = new Map([...BASE58_ALPHABET].map((character, index) => [character, index]));

function base58Encode(bytes) {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;

  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let index = 0; index < digits.length; index += 1) {
      const value = digits[index] * 256 + carry;
      digits[index] = value % 58;
      carry = Math.floor(value / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }

  let encoded = "1".repeat(zeros);
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    encoded += BASE58_ALPHABET[digits[index]];
  }
  return encoded;
}

function base58Decode(value) {
  if (typeof value !== "string" || value.length === 0) return null;

  let zeros = 0;
  while (zeros < value.length && value[zeros] === "1") zeros += 1;
  const bytes = [0];

  for (const character of value) {
    const digit = BASE58_INDEX.get(character);
    if (digit === undefined) return null;

    let carry = digit;
    for (let index = 0; index < bytes.length; index += 1) {
      const current = bytes[index] * 58 + carry;
      bytes[index] = current & 0xff;
      carry = current >> 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  const significantBytes = bytes[0] === 0 ? bytes.slice(1) : bytes;
  return Uint8Array.from([...new Uint8Array(zeros), ...significantBytes.reverse()]);
}

export function isValidPublicKey(value) {
  const decoded = base58Decode(value);
  return decoded !== null && decoded.length === 32;
}

export function parseSolToLamports(value) {
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text !== "string") throw new Error("SOL amount must be a decimal string or number");

  const match = /^(0|[1-9]\d*)(?:\.(\d{1,9}))?$/.exec(text.trim());
  if (!match) throw new Error("SOL amount must be a non-negative decimal with at most 9 decimals");

  const whole = BigInt(match[1]);
  const fraction = BigInt((match[2] ?? "").padEnd(9, "0") || "0");
  return whole * LAMPORTS_PER_SOL + fraction;
}

export function formatLamports(lamports) {
  const value = BigInt(lamports);
  const whole = value / LAMPORTS_PER_SOL;
  const fraction = (value % LAMPORTS_PER_SOL).toString().padStart(9, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

export function buildPaymentRequest({
  recipient,
  amountSol,
  label = "Agent payment",
  memo = "",
  maxSol = "0.01",
  reference = base58Encode(randomBytes(32)),
}) {
  if (!isValidPublicKey(recipient)) throw new Error("recipient must be a valid 32-byte Solana public key");
  if (!isValidPublicKey(reference)) throw new Error("reference must be a valid 32-byte Solana public key");
  if (typeof label !== "string" || label.length > 64) throw new Error("label must be at most 64 characters");
  if (typeof memo !== "string" || memo.length > 256) throw new Error("memo must be at most 256 characters");

  const amountLamports = parseSolToLamports(amountSol);
  const maxLamports = parseSolToLamports(maxSol);
  if (amountLamports <= 0n) throw new Error("amount must be greater than zero");
  if (amountLamports > maxLamports) {
    throw new Error(`amount exceeds configured cap of ${formatLamports(maxLamports)} SOL`);
  }

  const params = new URLSearchParams({
    amount: formatLamports(amountLamports),
    label,
    reference,
  });
  if (memo) params.set("memo", memo);

  return {
    uri: `solana:${recipient}?${params.toString()}`,
    recipient,
    reference,
    amountLamports,
    amountSol: formatLamports(amountLamports),
  };
}

export function buildSignatureLookupRequest(reference, commitment = "confirmed") {
  if (!isValidPublicKey(reference)) throw new Error("reference must be a valid 32-byte Solana public key");
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "getSignaturesForAddress",
    params: [reference, { commitment, limit: 20 }],
  };
}

function accountKeyValue(accountKey) {
  return typeof accountKey === "string" ? accountKey : accountKey?.pubkey;
}

export function verifyPaymentTransaction({ transaction, signature = null, recipient, reference, expectedLamports }) {
  if (!transaction) return { ok: false, reason: "transaction not found" };
  if (transaction.meta?.err != null) return { ok: false, reason: "transaction failed on-chain" };
  if (!isValidPublicKey(recipient) || !isValidPublicKey(reference)) {
    return { ok: false, reason: "recipient or reference is invalid" };
  }

  const accountKeys = transaction.transaction?.message?.accountKeys ?? [];
  if (!accountKeys.map(accountKeyValue).includes(reference)) {
    return { ok: false, reason: "payment reference was not present in the transaction" };
  }

  const expected = BigInt(expectedLamports);
  const transfers = (transaction.transaction?.message?.instructions ?? [])
    .filter((instruction) => instruction.program === "system" && instruction.parsed?.type === "transfer")
    .map((instruction) => instruction.parsed.info)
    .filter((info) => info?.destination === recipient && Number.isSafeInteger(info?.lamports));
  const receivedLamports = transfers.reduce((total, transfer) => total + BigInt(transfer.lamports), 0n);

  if (receivedLamports < expected) {
    return {
      ok: false,
      reason: "recipient received less than the requested amount",
      receivedLamports,
      expectedLamports: expected,
    };
  }

  return {
    ok: true,
    signature,
    receivedLamports,
    receivedSol: formatLamports(receivedLamports),
  };
}

export async function verifyPaymentWithRpc({
  rpcUrl,
  recipient,
  reference,
  expectedLamports,
  fetchImpl = globalThis.fetch,
}) {
  if (typeof fetchImpl !== "function") throw new Error("fetch is required for RPC verification");
  const lookupResponse = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(buildSignatureLookupRequest(reference)),
  });
  if (!lookupResponse.ok) throw new Error(`RPC lookup failed with HTTP ${lookupResponse.status}`);
  const lookup = await lookupResponse.json();
  if (lookup.error) throw new Error(`RPC lookup error: ${lookup.error.message ?? "unknown error"}`);

  for (const entry of lookup.result ?? []) {
    if (entry.err != null) continue;
    const transactionResponse = await fetchImpl(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "getParsedTransaction",
        params: [entry.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }],
      }),
    });
    if (!transactionResponse.ok) throw new Error(`RPC transaction lookup failed with HTTP ${transactionResponse.status}`);
    const transactionPayload = await transactionResponse.json();
    const result = verifyPaymentTransaction({
      transaction: transactionPayload.result,
      signature: entry.signature,
      recipient,
      reference,
      expectedLamports,
    });
    if (result.ok) return result;
  }

  return { ok: false, reason: "no matching confirmed payment found" };
}

