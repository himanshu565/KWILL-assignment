import { withTransaction } from "@/lib/db";
import { ApiError, jsonError, jsonOk } from "@/lib/errors";
import { getEventWithInventory } from "@/lib/inventory";
import { requestIdFrom, logEvent } from "@/lib/request";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  ctx: RouteContext<"/events/[eventId]">
) {
  const requestId = requestIdFrom(request);
  const { eventId } = await ctx.params;
  try {
    const data = await withTransaction((client) =>
      getEventWithInventory(client, eventId)
    );
    if (!data) {
      throw new ApiError(404, "EVENT_NOT_FOUND", `No event ${eventId}.`);
    }
    logEvent(requestId, { route: "GET /events/:eventId", event_id: eventId });
    return jsonOk(
      {
        id: data.event.id,
        title: data.event.title,
        venue: data.event.venue,
        starts_at: data.event.starts_at.toISOString(),
        tiers: data.tiers.map((tier) => ({
          id: tier.id,
          name: tier.name,
          price: tier.price,
          currency: tier.currency.trim(),
          total_inventory: tier.total_inventory,
          available: tier.available,
          held: tier.held,
          sold: tier.sold,
        })),
      },
      requestId
    );
  } catch (error) {
    return jsonError(error, requestId);
  }
}
