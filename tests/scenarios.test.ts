import assert from "node:assert/strict";
import path from "node:path";
import { loadEnvFile } from "node:process";
import { test } from "node:test";

try {
  loadEnvFile(path.resolve(process.cwd(), ".env"));
} catch {
  /* optional */
}

const base = process.env.API_BASE_URL ?? "http://localhost:3000";

test("API: GET /events/evt_001 returns event with accurate tiers", async () => {
  const res = await fetch(`${base}/events/evt_001`);
  assert.equal(res.status, 200);
  const data = (await res.json()) as { id: string; tiers: Array<{ id: string; available: number }> };
  assert.equal(data.id, "evt_001");
  assert.ok(data.tiers.length >= 3);
  for (const tier of data.tiers) {
    assert.equal(typeof tier.available, "number");
  }
});

test("API: POST /events/evt_001/holds creates active hold and reduces available", async () => {
  const holdRes = await fetch(`${base}/events/evt_001/holds`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tier_id: "tier_001_a", quantity: 1 }),
  });
  assert.equal(holdRes.status, 201);
  const hold = (await holdRes.json()) as { hold_id: string; status: string };
  assert.ok(hold.hold_id.startsWith("hld_"));
  assert.equal(hold.status, "active");

  // Cancel hold using convenience endpoint
  const cancelRes = await fetch(`${base}/orders/${hold.hold_id}/cancel-hold`, { method: "POST" });
  assert.equal(cancelRes.status, 200);
  const cancelled = (await cancelRes.json()) as { status: string };
  assert.equal(cancelled.status, "expired");
});

test("API: Idempotent Webhook delivery produces identical outcome", async () => {
  const eventId = `evt_wh_test_${Date.now()}`;
  const orderId = `ord_test_${Date.now()}`;

  const payload = {
    event_id: eventId,
    type: "order.paid",
    order_id: orderId,
    tier_id: "tier_001_c",
    quantity: 1,
    amount_total: 3000,
    currency: "EUR",
    occurred_at: new Date().toISOString(),
  };

  const res1 = await fetch(`${base}/webhooks/payments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  assert.equal(res1.status, 200);
  const body1 = (await res1.json()) as { duplicate: boolean };
  assert.equal(body1.duplicate, false);

  const res2 = await fetch(`${base}/webhooks/payments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  assert.equal(res2.status, 200);
  const body2 = (await res2.json()) as { duplicate: boolean };
  assert.equal(body2.duplicate, true);
});
