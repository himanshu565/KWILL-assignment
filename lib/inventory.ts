import type { PoolClient } from "pg";
import { query } from "./db";
import type { EventRow, TierInventoryRow } from "./types";

export async function expireStaleHolds(
  client: PoolClient,
  tierId?: string
): Promise<number> {
  const result = tierId
    ? await query(
        client,
        `UPDATE holds
         SET status = 'expired'
         WHERE status = 'active'
           AND expires_at <= now()
           AND tier_id = $1`,
        [tierId]
      )
    : await query(
        client,
        `UPDATE holds
         SET status = 'expired'
         WHERE status = 'active'
           AND expires_at <= now()`
      );
  return result.rowCount ?? 0;
}

export async function getEventWithInventory(
  client: PoolClient,
  eventId: string
): Promise<{ event: EventRow; tiers: TierInventoryRow[] } | null> {
  await expireStaleHolds(client);

  const eventResult = await query<EventRow>(
    client,
    `SELECT id, title, venue, starts_at FROM events WHERE id = $1`,
    [eventId]
  );
  const event = eventResult.rows[0];
  if (!event) {
    return null;
  }

  const tiers = await query<TierInventoryRow>(
    client,
    `SELECT
       t.id,
       t.name,
       t.price,
       t.currency,
       t.total_inventory,
       COALESCE(h.held, 0)::int AS held,
       COALESCE(o.sold, 0)::int AS sold,
       (t.total_inventory - COALESCE(h.held, 0) - COALESCE(o.sold, 0))::int AS available
     FROM tiers t
     LEFT JOIN (
       SELECT tier_id, SUM(quantity)::int AS held
       FROM holds
       WHERE status = 'active' AND expires_at > now()
       GROUP BY tier_id
     ) h ON h.tier_id = t.id
     LEFT JOIN (
       SELECT tier_id, SUM(quantity)::int AS sold
       FROM orders
       WHERE status = 'paid'
       GROUP BY tier_id
     ) o ON o.tier_id = t.id
     WHERE t.event_id = $1
     ORDER BY t.price DESC`,
    [eventId]
  );

  return { event, tiers: tiers.rows };
}
