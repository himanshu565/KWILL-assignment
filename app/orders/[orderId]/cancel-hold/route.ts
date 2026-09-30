import { withTransaction } from "@/lib/db";
import { jsonError, jsonOk } from "@/lib/errors";
import { cancelHold } from "@/lib/holds";
import { requestIdFrom, logEvent } from "@/lib/request";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  ctx: RouteContext<"/orders/[orderId]/cancel-hold">
) {
  const requestId = requestIdFrom(request);
  const { orderId } = await ctx.params;
  try {
    const hold = await withTransaction((client) => cancelHold(client, orderId));
    logEvent(requestId, {
      route: "POST /orders/:orderId/cancel-hold",
      hold_id: hold.id,
    });
    return jsonOk(
      {
        hold_id: hold.id,
        status: hold.status,
        tier_id: hold.tier_id,
        quantity: hold.quantity,
      },
      requestId
    );
  } catch (error) {
    return jsonError(error, requestId);
  }
}
