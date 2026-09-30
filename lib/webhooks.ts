import type { PoolClient } from "pg";
import { query } from "./db";
import { ApiError } from "./errors";
import { convertMatchingHold } from "./holds";
import { expireStaleHolds } from "./inventory";
import type {
  OrderPaidWebhook,
  OrderRefundedWebhook,
  OrderRow,
  PaymentWebhook,
} from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

export function parsePaymentWebhook(body: unknown): PaymentWebhook {
  if (!isRecord(body)) {
    throw new ApiError(400, "WEBHOOK_INVALID", "Webhook body must be a JSON object.");
  }
  const eventId = asString(body.event_id);
  const type = asString(body.type);
  const orderId = asString(body.order_id);
  const occurredAt = asString(body.occurred_at);
  const currency = asString(body.currency);
  if (!eventId || !type || !orderId || !occurredAt || !currency) {
    throw new ApiError(
      400,
      "WEBHOOK_INVALID",
      "event_id, type, order_id, currency, and occurred_at are required."
    );
  }
  if (currency.length !== 3) {
    throw new ApiError(400, "WEBHOOK_INVALID", "currency must be ISO 4217.");
  }

  if (type === "order.paid") {
    const tierId = asString(body.tier_id);
    const quantity = asInt(body.quantity);
    const amountTotal = asInt(body.amount_total);
    if (!tierId || quantity === undefined || amountTotal === undefined) {
      throw new ApiError(
        400,
        "WEBHOOK_INVALID",
        "order.paid requires tier_id, quantity, and amount_total."
      );
    }
    if (quantity < 1 || amountTotal < 0) {
      throw new ApiError(400, "WEBHOOK_INVALID", "quantity or amount_total is invalid.");
    }
    const holdId = asString(body.hold_id);
    const paid: OrderPaidWebhook = {
      event_id: eventId,
      type: "order.paid",
      order_id: orderId,
      tier_id: tierId,
      quantity,
      amount_total: amountTotal,
      currency,
      occurred_at: occurredAt,
    };
    if (holdId) {
      paid.hold_id = holdId;
    }
    return paid;
  }

  if (type === "order.refunded") {
    const amountRefunded = asInt(body.amount_refunded);
    if (amountRefunded === undefined || amountRefunded < 0) {
      throw new ApiError(
        400,
        "WEBHOOK_INVALID",
        "order.refunded requires amount_refunded."
      );
    }
    const refunded: OrderRefundedWebhook = {
      event_id: eventId,
      type: "order.refunded",
      order_id: orderId,
      amount_refunded: amountRefunded,
      currency,
      occurred_at: occurredAt,
    };
    return refunded;
  }

  throw new ApiError(400, "WEBHOOK_INVALID", `Unsupported webhook type ${type}.`);
}

async function claimWebhook(
  client: PoolClient,
  eventId: string,
  eventType: string,
  payload: PaymentWebhook
): Promise<"duplicate" | "claimed"> {
  const inserted = await query(
    client,
    `INSERT INTO webhook_events (id, event_type, payload, processed_at)
     VALUES ($1, $2, $3::jsonb, now())
     ON CONFLICT (id) DO NOTHING`,
    [eventId, eventType, JSON.stringify(payload)]
  );
  if ((inserted.rowCount ?? 0) === 0) {
    return "duplicate";
  }
  return "claimed";
}

async function applyRefundToOrder(
  client: PoolClient,
  orderId: string,
  amountRefunded: number
): Promise<OrderRow | null> {
  const existing = await query<{ amount_total: number }>(
    client,
    `SELECT amount_total FROM orders WHERE id = $1 FOR UPDATE`,
    [orderId]
  );
  const order = existing.rows[0];
  if (!order) {
    return null;
  }
  if (amountRefunded > order.amount_total) {
    throw new ApiError(
      422,
      "REFUND_EXCEEDS_ORDER",
      "amount_refunded cannot exceed amount_total."
    );
  }
  const updated = await query<OrderRow>(
    client,
    `UPDATE orders
     SET
       amount_refunded = GREATEST(amount_refunded, $2),
       status = CASE
         WHEN GREATEST(amount_refunded, $2) >= amount_total THEN 'refunded'::order_status
         ELSE 'partially_refunded'::order_status
       END,
       refunded_at = now()
     WHERE id = $1
     RETURNING id, tier_id, quantity, status, amount_total, amount_refunded, currency`,
    [orderId, amountRefunded]
  );
  return updated.rows[0] ?? null;
}

async function applyStoredRefunds(client: PoolClient, orderId: string): Promise<void> {
  const pending = await query<{ payload: unknown }>(
    client,
    `SELECT payload
     FROM webhook_events
     WHERE event_type = 'order.refunded'
       AND payload ->> 'order_id' = $1
     ORDER BY received_at ASC`,
    [orderId]
  );
  for (const row of pending.rows) {
    if (!isRecord(row.payload)) {
      continue;
    }
    const amount = asInt(row.payload.amount_refunded);
    if (amount === undefined) {
      continue;
    }
    await applyRefundToOrder(client, orderId, amount);
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "23505"
  );
}

async function handlePaid(
  client: PoolClient,
  webhook: OrderPaidWebhook
): Promise<{ duplicate: boolean; order: OrderRow; hold_id: string | null }> {
  const existing = await query<OrderRow>(
    client,
    `SELECT id, tier_id, quantity, status, amount_total, amount_refunded, currency
     FROM orders
     WHERE id = $1
     FOR UPDATE`,
    [webhook.order_id]
  );
  const already = existing.rows[0];
  if (already) {
    return { duplicate: true, order: already, hold_id: null };
  }

  const tier = await query<{ id: string }>(
    client,
    `SELECT id FROM tiers WHERE id = $1 FOR UPDATE`,
    [webhook.tier_id]
  );
  if (!tier.rows[0]) {
    throw new ApiError(422, "TIER_NOT_FOUND", `Unknown tier ${webhook.tier_id}.`);
  }

  await expireStaleHolds(client, webhook.tier_id);

  let inserted;
  try {
    inserted = await query<OrderRow>(
      client,
      `INSERT INTO orders (
         id, tier_id, quantity, status, amount_total, amount_refunded, currency, paid_at
       ) VALUES ($1, $2, $3, 'paid', $4, 0, $5, $6::timestamptz)
       RETURNING id, tier_id, quantity, status, amount_total, amount_refunded, currency`,
      [
        webhook.order_id,
        webhook.tier_id,
        webhook.quantity,
        webhook.amount_total,
        webhook.currency,
        webhook.occurred_at,
      ]
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      const raced = await query<OrderRow>(
        client,
        `SELECT id, tier_id, quantity, status, amount_total, amount_refunded, currency
         FROM orders WHERE id = $1`,
        [webhook.order_id]
      );
      const row = raced.rows[0];
      if (row) {
        return { duplicate: true, order: row, hold_id: null };
      }
    }
    throw error;
  }
  const order = inserted.rows[0];
  if (!order) {
    throw new ApiError(500, "INTERNAL", "Failed to insert paid order.");
  }

  const holdId = await convertMatchingHold(
    client,
    webhook.order_id,
    webhook.tier_id,
    webhook.quantity,
    webhook.hold_id
  );
  if (!holdId) {
    throw new ApiError(
      409,
      "HOLD_NOT_FOUND",
      "The paid order does not have a matching active hold."
    );
  }

  await applyStoredRefunds(client, webhook.order_id);

  const fresh = await query<OrderRow>(
    client,
    `SELECT id, tier_id, quantity, status, amount_total, amount_refunded, currency
     FROM orders WHERE id = $1`,
    [webhook.order_id]
  );
  const updated = fresh.rows[0] ?? order;
  return { duplicate: false, order: updated, hold_id: holdId };
}

async function handleRefunded(
  client: PoolClient,
  webhook: OrderRefundedWebhook
): Promise<{ duplicate: boolean; deferred: boolean; order: OrderRow | null }> {
  const existing = await query<OrderRow>(
    client,
    `SELECT id, tier_id, quantity, status, amount_total, amount_refunded, currency
     FROM orders
     WHERE id = $1
     FOR UPDATE`,
    [webhook.order_id]
  );
  const order = existing.rows[0];
  if (!order) {
    return { duplicate: false, deferred: true, order: null };
  }
  const applied = await applyRefundToOrder(
    client,
    webhook.order_id,
    webhook.amount_refunded
  );
  return { duplicate: false, deferred: false, order: applied };
}

export async function processPaymentWebhook(
  client: PoolClient,
  webhook: PaymentWebhook
): Promise<{
  duplicate: boolean;
  deferred?: boolean;
  order: OrderRow | null;
  hold_id?: string | null;
}> {
  const claim = await claimWebhook(client, webhook.event_id, webhook.type, webhook);
  if (claim === "duplicate") {
    const existingOrder = await query<OrderRow>(
      client,
      `SELECT id, tier_id, quantity, status, amount_total, amount_refunded, currency
       FROM orders WHERE id = $1`,
      [webhook.order_id]
    );
    return {
      duplicate: true,
      deferred: !existingOrder.rows[0] && webhook.type === "order.refunded",
      order: existingOrder.rows[0] ?? null,
    };
  }

  if (webhook.type === "order.paid") {
    const result = await handlePaid(client, webhook);
    return result;
  }
  return handleRefunded(client, webhook);
}
