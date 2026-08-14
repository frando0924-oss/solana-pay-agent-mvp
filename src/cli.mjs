import { buildPaymentRequest } from "./index.mjs";

const [, , recipient, amountSol = "0.000001", ...memoParts] = process.argv;
if (!recipient) {
  console.error("Usage: npm run demo -- <recipient-pubkey> [amount-sol] [memo]");
  process.exitCode = 1;
} else {
  const request = buildPaymentRequest({
    recipient,
    amountSol,
    memo: memoParts.join(" "),
  });
  console.log(JSON.stringify({ ...request, amountLamports: request.amountLamports.toString() }, null, 2));
}

