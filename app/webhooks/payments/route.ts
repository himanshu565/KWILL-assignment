import { withTransaction } from "@/lib/db";
import { jsonError, jsonOk } from "@/lib/errors";
import { requestIdFrom, logEvent } from "@/lib/request";
import { parsePaymentWebhook, processPaymentWebhook } from "@/lib/webhooks";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const requestId = requestIdFrom(request);
  try {
    const body: unknown = await request.json();
    const webhook = parsePaymentWebhook(body);
    const result = await withTransaction((client) =>
      processPaymentWebhook(client, webhook)
    );
    logEvent(requestId, {
      route: "POST /webhooks/payments",
      event_id: webhook.event_id,
      type: webhook.type,
      order_id: webhook.order_id,
      duplicate: result.duplicate,
    });
    return jsonOk(
      {
        received: true,
        duplicate: result.duplicate,
        deferred: result.deferred ?? false,
        order: result.order,
        hold_id: result.hold_id ?? null,
      },
      requestId
    );
  } catch (error) {
    return jsonError(error, requestId);
  }
}
