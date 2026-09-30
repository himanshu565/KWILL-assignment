import { withTransaction } from "@/lib/db";
import { ApiError, jsonError, jsonOk } from "@/lib/errors";
import { createHold } from "@/lib/holds";
import { requestIdFrom, logEvent } from "@/lib/request";

export const runtime = "nodejs";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function POST(
  request: Request,
  ctx: RouteContext<"/events/[eventId]/holds">
) {
  const requestId = requestIdFrom(request);
  const { eventId } = await ctx.params;
  try {
    const body: unknown = await request.json();
    if (!isRecord(body)) {
      throw new ApiError(400, "INVALID_BODY", "JSON object required.");
    }
    const tierId = typeof body.tier_id === "string" ? body.tier_id : undefined;
    const quantity =
      typeof body.quantity === "number" ? body.quantity : undefined;
    if (!tierId || quantity === undefined) {
      throw new ApiError(
        400,
        "INVALID_BODY",
        'Body must be { "tier_id": "...", "quantity": N }.'
      );
    }

    const hold = await withTransaction((client) =>
      createHold(client, eventId, tierId, quantity)
    );
    logEvent(requestId, {
      route: "POST /events/:eventId/holds",
      event_id: eventId,
      tier_id: tierId,
      hold_id: hold.id,
      quantity,
    });
    return jsonOk(
      {
        hold_id: hold.id,
        tier_id: hold.tier_id,
        quantity: hold.quantity,
        expires_at: hold.expires_at.toISOString(),
        status: hold.status,
      },
      requestId,
      201
    );
  } catch (error) {
    return jsonError(error, requestId);
  }
}
