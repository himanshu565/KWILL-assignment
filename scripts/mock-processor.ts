import path from "node:path";
import { loadEnvFile } from "node:process";

try {
  loadEnvFile(path.resolve(process.cwd(), ".env"));
} catch {
  /* optional */
}

const base = process.env.API_BASE_URL ?? "http://localhost:3000";

type PaidInput = {
  eventId: string;
  orderId: string;
  tierId: string;
  quantity: number;
  amountTotal: number;
  holdId?: string;
};

function paidPayload(input: PaidInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    event_id: input.eventId,
    type: "order.paid",
    order_id: input.orderId,
    tier_id: input.tierId,
    quantity: input.quantity,
    amount_total: input.amountTotal,
    currency: "EUR",
    occurred_at: new Date().toISOString(),
  };
  if (input.holdId) {
    body.hold_id = input.holdId;
  }
  return body;
}

function refundPayload(eventId: string, orderId: string, amount: number): Record<string, unknown> {
  return {
    event_id: eventId,
    type: "order.refunded",
    order_id: orderId,
    amount_refunded: amount,
    currency: "EUR",
    occurred_at: new Date().toISOString(),
  };
}

async function postWebhook(body: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(`${base}/webhooks/payments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json: unknown = await response.json();
  console.log(response.status, JSON.stringify(json, null, 2));
  if (!response.ok) {
    throw new Error(`webhook failed: ${response.status}`);
  }
  return json;
}

async function main(): Promise<void> {
  const [, , kind, ...rest] = process.argv;
  if (kind === "paid") {
    const [eventId, orderId, tierId, quantityRaw, amountRaw, holdId] = rest;
    if (!eventId || !orderId || !tierId || !quantityRaw || !amountRaw) {
      throw new Error(
        "Usage: tsx scripts/mock-processor.ts paid <event_id> <order_id> <tier_id> <quantity> <amount_total> [hold_id]"
      );
    }
    await postWebhook(
      paidPayload({
        eventId,
        orderId,
        tierId,
        quantity: Number(quantityRaw),
        amountTotal: Number(amountRaw),
        holdId,
      })
    );
    return;
  }
  if (kind === "refund") {
    const [eventId, orderId, amountRaw] = rest;
    if (!eventId || !orderId || !amountRaw) {
      throw new Error(
        "Usage: tsx scripts/mock-processor.ts refund <event_id> <order_id> <amount_refunded>"
      );
    }
    await postWebhook(refundPayload(eventId, orderId, Number(amountRaw)));
    return;
  }
  throw new Error("Usage: tsx scripts/mock-processor.ts paid|refund ...");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
