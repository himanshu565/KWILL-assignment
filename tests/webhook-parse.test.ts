import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePaymentWebhook } from "../lib/webhooks";

test("unit: parsePaymentWebhook accepts valid order.paid payload", () => {
  const parsed = parsePaymentWebhook({
    event_id: "evt_wh_unit_1",
    type: "order.paid",
    order_id: "ord_unit_1",
    tier_id: "tier_001_a",
    quantity: 2,
    amount_total: 17000,
    currency: "EUR",
    occurred_at: "2026-06-25T11:32:14Z",
  });
  assert.equal(parsed.type, "order.paid");
  if (parsed.type === "order.paid") {
    assert.equal(parsed.quantity, 2);
    assert.equal(parsed.amount_total, 17000);
  }
});

test("unit: parsePaymentWebhook accepts valid order.refunded payload", () => {
  const parsed = parsePaymentWebhook({
    event_id: "evt_wh_unit_2",
    type: "order.refunded",
    order_id: "ord_unit_1",
    amount_refunded: 17000,
    currency: "EUR",
    occurred_at: "2026-06-25T14:08:51Z",
  });
  assert.equal(parsed.type, "order.refunded");
});

test("unit: rejects missing required webhook fields with 400", () => {
  assert.throws(() => {
    parsePaymentWebhook({
      event_id: "evt_invalid",
      type: "order.paid",
      // missing order_id, currency, occurred_at
    });
  });
});
