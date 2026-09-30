import { nanoid } from "nanoid";
import type { PoolClient } from "pg";
import { query } from "./db";
import { ApiError } from "./errors";
import { expireStaleHolds } from "./inventory";
import type { HoldRow } from "./types";

function holdTtlSeconds(): number {
  const raw = process.env.HOLD_TTL_SECONDS;
  if (!raw) {
    return 600;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 600;
}

export async function createHold(
  client: PoolClient,
  eventId: string,
  tierId: string,
  quantity: number
): Promise<HoldRow> {
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new ApiError(
      400,
      "INVALID_QUANTITY",
      "quantity must be an integer of at least 1."
    );
  }

  const locked = await query<{ id: string }>(
    client,
    `SELECT id FROM tiers WHERE id = $1 AND event_id = $2 FOR UPDATE`,
    [tierId, eventId]
  );
  if (!locked.rows[0]) {
    throw new ApiError(
      404,
      "TIER_NOT_FOUND",
      `Tier ${tierId} is not on event ${eventId}.`
    );
  }

  await expireStaleHolds(client, tierId);

  const holdId = `hld_${nanoid(12)}`;
  const inserted = await query<HoldRow>(
    client,
    `INSERT INTO holds (id, tier_id, quantity, expires_at, status)
     SELECT $1, t.id, $2::integer, now() + ($3::integer * interval '1 second'), 'active'::hold_status
     FROM tiers t
     WHERE t.id = $4
       AND t.total_inventory
         - COALESCE((
             SELECT SUM(h.quantity) FROM holds h
             WHERE h.tier_id = t.id
               AND h.status = 'active'
               AND h.expires_at > now()
           ), 0)
         - COALESCE((
             SELECT SUM(o.quantity) FROM orders o
             WHERE o.tier_id = t.id
               AND o.status = 'paid'
           ), 0)
         >= $2::integer
     RETURNING id, tier_id, quantity, expires_at, status, converted_order_id`,
    [holdId, quantity, holdTtlSeconds(), tierId]
  );

  const hold = inserted.rows[0];
  if (!hold) {
    throw new ApiError(
      409,
      "OVERSOLD",
      "Not enough tickets left on this tier. Another checkout probably grabbed the last seats."
    );
  }
  return hold;
}

export async function cancelHold(
  client: PoolClient,
  holdId: string
): Promise<HoldRow> {
  const existing = await query<HoldRow>(
    client,
    `SELECT id, tier_id, quantity, expires_at, status, converted_order_id
     FROM holds
     WHERE id = $1
     FOR UPDATE`,
    [holdId]
  );
  const hold = existing.rows[0];
  if (!hold) {
    throw new ApiError(404, "HOLD_NOT_FOUND", `No hold ${holdId}.`);
  }
  if (hold.status !== "active") {
    throw new ApiError(
      409,
      "HOLD_NOT_ACTIVE",
      `Hold ${holdId} is ${hold.status}, so it cannot be cancelled.`
    );
  }

  const updated = await query<HoldRow>(
    client,
    `UPDATE holds
     SET status = 'expired'
     WHERE id = $1
     RETURNING id, tier_id, quantity, expires_at, status, converted_order_id`,
    [holdId]
  );
  const cancelled = updated.rows[0];
  if (!cancelled) {
    throw new ApiError(404, "HOLD_NOT_FOUND", `No hold ${holdId}.`);
  }
  return cancelled;
}

export async function convertMatchingHold(
  client: PoolClient,
  orderId: string,
  tierId: string,
  quantity: number,
  holdId: string | undefined
): Promise<string | null> {
  if (holdId) {
    const specific = await query<HoldRow>(
      client,
      `SELECT id, tier_id, quantity, expires_at, status, converted_order_id
       FROM holds
       WHERE id = $1
       FOR UPDATE`,
      [holdId]
    );
    const hold = specific.rows[0];
    if (
      hold &&
      hold.status === "active" &&
      hold.tier_id === tierId &&
      hold.quantity === quantity
    ) {
      await query(
        client,
        `UPDATE holds
         SET status = 'converted', converted_order_id = $2
         WHERE id = $1`,
        [hold.id, orderId]
      );
      return hold.id;
    }
  }

  const fifo = await query<{ id: string }>(
    client,
    `SELECT id
     FROM holds
     WHERE tier_id = $1
       AND status = 'active'
       AND expires_at > now()
       AND quantity = $2
     ORDER BY created_at ASC
     FOR UPDATE SKIP LOCKED
     LIMIT 1`,
    [tierId, quantity]
  );
  const match = fifo.rows[0];
  if (!match) {
    return null;
  }
  await query(
    client,
    `UPDATE holds
     SET status = 'converted', converted_order_id = $2
     WHERE id = $1`,
    [match.id, orderId]
  );
  return match.id;
}
