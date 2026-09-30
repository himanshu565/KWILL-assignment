import { getPool } from "@/lib/db";
import { ApiError, jsonError, jsonOk } from "@/lib/errors";
import { requestIdFrom } from "@/lib/request";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  ctx: RouteContext<"/admin/orders/[orderId]/audit">
) {
  const requestId = requestIdFrom(request);
  const { orderId } = await ctx.params;
  try {
    const pool = getPool();
    const order = await pool.query(
      `SELECT id, tier_id, quantity, status, amount_total, amount_refunded, currency, paid_at, refunded_at, created_at
       FROM orders WHERE id = $1`,
      [orderId]
    );
    if (!order.rows[0]) {
      throw new ApiError(404, "ORDER_NOT_FOUND", `No order ${orderId} yet.`);
    }
    const holds = await pool.query(
      `SELECT id, tier_id, quantity, status, expires_at, converted_order_id, created_at
       FROM holds WHERE converted_order_id = $1`,
      [orderId]
    );
    const webhooks = await pool.query(
      `SELECT id, event_type, payload, received_at, processed_at
       FROM webhook_events
       WHERE payload ->> 'order_id' = $1
       ORDER BY received_at ASC`,
      [orderId]
    );
    return jsonOk(
      {
        order: order.rows[0],
        holds: holds.rows,
        webhooks: webhooks.rows,
      },
      requestId
    );
  } catch (error) {
    return jsonError(error, requestId);
  }
}
