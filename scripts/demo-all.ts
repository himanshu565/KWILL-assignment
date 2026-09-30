import path from "node:path";
import { loadEnvFile } from "node:process";

try {
  loadEnvFile(path.resolve(process.cwd(), ".env"));
} catch {
  /* optional */
}

const base = process.env.API_BASE_URL ?? "http://localhost:3000";

type Tier = {
  id: string;
  name: string;
  price: number;
  total_inventory: number;
  available: number;
  held: number;
  sold: number;
};

type EventResponse = {
  id: string;
  title: string;
  venue: string;
  tiers: Tier[];
};

type HoldResponse = {
  hold_id?: string;
  tier_id?: string;
  quantity?: number;
  expires_at?: string;
  status?: string;
  error?: { code: string; message: string };
};

type WebhookResponse = {
  received?: boolean;
  duplicate?: boolean;
  deferred?: boolean;
  order?: {
    id: string;
    tier_id: string;
    quantity: number;
    status: string;
    amount_total: number;
    amount_refunded: number;
  };
  hold_id?: string | null;
  error?: { code: string; message: string };
};

async function getEvent(eventId: string): Promise<EventResponse> {
  const res = await fetch(`${base}/events/${eventId}`);
  if (!res.ok) throw new Error(`Failed to fetch event ${eventId}: ${res.status}`);
  return (await res.json()) as EventResponse;
}

async function createHold(eventId: string, tierId: string, quantity: number): Promise<{ status: number; body: HoldResponse }> {
  const res = await fetch(`${base}/events/${eventId}/holds`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tier_id: tierId, quantity }),
  });
  const body = (await res.json()) as HoldResponse;
  return { status: res.status, body };
}

async function sendWebhook(body: Record<string, unknown>): Promise<{ status: number; body: WebhookResponse }> {
  const res = await fetch(`${base}/webhooks/payments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as WebhookResponse;
  return { status: res.status, body: json };
}

function divider(title: string): void {
  console.log("\n" + "=".repeat(60));
  console.log(`📌 ${title}`);
  console.log("=".repeat(60));
}

async function runScenarioA(): Promise<void> {
  divider("SCENARIO A — HAPPY PATH (Hold -> Paid Webhook -> Sold)");
  
  // 1. Initial State
  const initial = await getEvent("evt_001");
  const initialTier = initial.tiers.find((t) => t.id === "tier_001_b")!;
  console.log(`1. Initial Inventory for "${initialTier.name}": Available=${initialTier.available}, Held=${initialTier.held}, Sold=${initialTier.sold}`);

  // 2. User adds 3 tickets to cart -> hold created
  const holdRes = await createHold("evt_001", "tier_001_b", 3);
  if (holdRes.status !== 201 || !holdRes.body.hold_id) {
    throw new Error(`Hold failed: ${JSON.stringify(holdRes.body)}`);
  }
  const holdId = holdRes.body.hold_id;
  console.log(`2. Hold created: ID=${holdId}, Quantity=3, ExpiresAt=${holdRes.body.expires_at}`);

  // 3. Verify held inventory
  const heldState = await getEvent("evt_001");
  const heldTier = heldState.tiers.find((t) => t.id === "tier_001_b")!;
  console.log(`3. Inventory during Hold: Available=${heldTier.available}, Held=${heldTier.held}, Sold=${heldTier.sold}`);
  if (heldTier.available !== initialTier.available - 3 || heldTier.held !== initialTier.held + 3) {
    throw new Error("Inventory not accurately deducted during hold!");
  }

  // 4. Webhook order.paid arrives from payment processor
  const orderId = `ord_demo_a_${Date.now()}`;
  const webhookRes = await sendWebhook({
    event_id: `evt_wh_demo_a_${Date.now()}`,
    type: "order.paid",
    order_id: orderId,
    tier_id: "tier_001_b",
    quantity: 3,
    amount_total: 13500, // 3 * 4500
    currency: "EUR",
    occurred_at: new Date().toISOString(),
    hold_id: holdId,
  });
  console.log(`4. Webhook order.paid processed: Status=${webhookRes.status}, OrderId=${webhookRes.body.order?.id}, OrderStatus=${webhookRes.body.order?.status}`);

  // 5. Final state: hold converted, tickets marked sold, no double deduction
  const finalState = await getEvent("evt_001");
  const finalTier = finalState.tiers.find((t) => t.id === "tier_001_b")!;
  console.log(`5. Final Inventory after Paid: Available=${finalTier.available}, Held=${finalTier.held}, Sold=${finalTier.sold}`);
  
  if (finalTier.available !== initialTier.available - 3 || finalTier.sold !== initialTier.sold + 3 || finalTier.held !== initialTier.held) {
    throw new Error("Scenario A assertion failed!");
  }
  console.log("✅ Scenario A Passed: Tickets safely held, converted, and deducted without overselling.");
}

async function runScenarioB(): Promise<void> {
  divider("SCENARIO B — IDEMPOTENT DELIVERY (Duplicate Webhook)");

  const orderId = `ord_demo_b_${Date.now()}`;
  const eventId = `evt_wh_demo_b_${Date.now()}`;

  // 1. Initial State
  const initial = await getEvent("evt_001");
  const initialTier = initial.tiers.find((t) => t.id === "tier_001_c")!;
  console.log(`1. Initial Inventory for "${initialTier.name}": Available=${initialTier.available}, Sold=${initialTier.sold}`);

  // 2. First Webhook delivery
  const payload = {
    event_id: eventId,
    type: "order.paid",
    order_id: orderId,
    tier_id: "tier_001_c",
    quantity: 2,
    amount_total: 6000,
    currency: "EUR",
    occurred_at: new Date().toISOString(),
  };

  const firstDelivery = await sendWebhook(payload);
  console.log(`2. First delivery: HTTP ${firstDelivery.status}, duplicate=${firstDelivery.body.duplicate}`);

  const midState = await getEvent("evt_001");
  const midTier = midState.tiers.find((t) => t.id === "tier_001_c")!;
  console.log(`3. Inventory after 1st delivery: Available=${midTier.available}, Sold=${midTier.sold}`);

  // 3. Second Webhook delivery (duplicate retry with same event_id)
  const secondDelivery = await sendWebhook(payload);
  console.log(`4. Second delivery (duplicate): HTTP ${secondDelivery.status}, duplicate=${secondDelivery.body.duplicate}`);

  // 4. Verify inventory remained IDENTICAL
  const finalState = await getEvent("evt_001");
  const finalTier = finalState.tiers.find((t) => t.id === "tier_001_c")!;
  console.log(`5. Inventory after 2nd delivery: Available=${finalTier.available}, Sold=${finalTier.sold}`);

  if (secondDelivery.body.duplicate !== true || finalTier.available !== midTier.available || finalTier.sold !== midTier.sold) {
    throw new Error("Scenario B failed: Duplicate delivery caused side-effects or failed idempotency!");
  }
  console.log("✅ Scenario B Passed: Duplicate webhook recognized and safely ignored with zero double-deduction.");
}

async function runScenarioC(): Promise<void> {
  divider("SCENARIO C — CONCURRENCY RACE CONDITION (2 requests for last ticket)");

  // 1. Check Student tier on Berlin meetup
  const eventBefore = await getEvent("evt_002");
  const studentTier = eventBefore.tiers.find((t) => t.id === "tier_002_b")!;
  console.log(`1. Current Student tier available tickets: ${studentTier.available}`);

  // Drain inventory to exactly 1 ticket remaining
  const excess = studentTier.available - 1;
  if (excess > 0) {
    console.log(`2. Holding ${excess} tickets to leave exactly 1 ticket in inventory...`);
    for (let i = 0; i < excess; i++) {
      const h = await createHold("evt_002", "tier_002_b", 1);
      if (h.status !== 201) throw new Error("Failed while preparing last ticket");
    }
  }

  const exactlyOne = await getEvent("evt_002");
  const readyTier = exactlyOne.tiers.find((t) => t.id === "tier_002_b")!;
  console.log(`3. Verified ready state: Available=${readyTier.available} (exactly 1 ticket remaining)`);

  // 4. Fire 2 simultaneous hold requests concurrently using Promise.all
  console.log(`4. Firing 2 concurrent requests simultaneously for the last ticket...`);
  const [reqA, reqB] = await Promise.all([
    createHold("evt_002", "tier_002_b", 1),
    createHold("evt_002", "tier_002_b", 1),
  ]);

  console.log(`   Request A: HTTP ${reqA.status}`, reqA.body);
  console.log(`   Request B: HTTP ${reqB.status}`, reqB.body);

  const statuses = [reqA.status, reqB.status].sort();
  if (statuses[0] !== 201 || statuses[1] !== 409) {
    throw new Error(`Scenario C failed: Expected [201, 409], got [${statuses[0]}, ${statuses[1]}]`);
  }

  const rejected = reqA.status === 409 ? reqA.body : reqB.body;
  if (rejected.error?.code !== "OVERSOLD") {
    throw new Error(`Expected error code 'OVERSOLD', got '${rejected.error?.code}'`);
  }

  const finalCheck = await getEvent("evt_002");
  const finalTier = finalCheck.tiers.find((t) => t.id === "tier_002_b")!;
  console.log(`5. Final Student inventory: Available=${finalTier.available}, Held=${finalTier.held}`);

  if (finalTier.available !== 0) {
    throw new Error("Overselling occurred!");
  }
  console.log("✅ Scenario C Passed: Pessimistic locking serialized checkout. Exactly 1 succeeded (201), 1 received structured 409 OVERSOLD.");
}

async function runScenarioOutOfOrder(): Promise<void> {
  divider("BONUS: OUT-OF-ORDER WEBHOOK DELIVERY (Refund arrives before Paid)");

  const orderId = `ord_ooo_${Date.now()}`;
  const refundEventId = `evt_wh_ref_${Date.now()}`;
  const paidEventId = `evt_wh_paid_${Date.now()}`;

  // 1. Initial State
  const initial = await getEvent("evt_001");
  const initialTier = initial.tiers.find((t) => t.id === "tier_001_a")!;
  console.log(`1. Initial Available for "${initialTier.name}": ${initialTier.available}`);

  // 2. User creates a hold
  const holdRes = await createHold("evt_001", "tier_001_a", 1);
  console.log(`2. Hold created: ${holdRes.body.hold_id}`);

  // 3. Network re-ordering: order.refunded arrives FIRST!
  console.log(`3. Sending order.refunded FIRST (before order.paid)...`);
  const refundRes = await sendWebhook({
    event_id: refundEventId,
    type: "order.refunded",
    order_id: orderId,
    amount_refunded: 8500,
    currency: "EUR",
    occurred_at: new Date().toISOString(),
  });
  console.log(`   Refund response: HTTP ${refundRes.status}, deferred=${refundRes.body.deferred}`);

  // 4. Delayed order.paid arrives second
  console.log(`4. Sending delayed order.paid second...`);
  const paidRes = await sendWebhook({
    event_id: paidEventId,
    type: "order.paid",
    order_id: orderId,
    tier_id: "tier_001_a",
    quantity: 1,
    amount_total: 8500,
    currency: "EUR",
    occurred_at: new Date().toISOString(),
    hold_id: holdRes.body.hold_id,
  });
  console.log(`   Paid response: HTTP ${paidRes.status}, Final Order Status=${paidRes.body.order?.status}`);

  // 5. Final State: order is refunded, hold is converted, tickets are returned to inventory!
  const finalState = await getEvent("evt_001");
  const finalTier = finalState.tiers.find((t) => t.id === "tier_001_a")!;
  console.log(`5. Final Available: ${finalTier.available} (matches initial: ${initialTier.available})`);

  if (paidRes.body.order?.status !== "refunded" || finalTier.available !== initialTier.available) {
    throw new Error("Out-of-order webhook delivery failed!");
  }
  console.log("✅ Out-of-Order Webhooks Passed: Commutative state machine automatically resolved refund upon paid arrival.");
}

async function main(): Promise<void> {
  console.log("\n🚀 RUNNING ENCORE TICKETS BACKEND VERIFICATION SUITE");
  console.log(`Target API Base URL: ${base}\n`);
  
  await runScenarioA();
  await runScenarioB();
  await runScenarioC();
  await runScenarioOutOfOrder();

  console.log("\n" + "=".repeat(60));
  console.log("🎉 ALL VERIFICATION SCENARIOS PASSED WITH 100% CORRECTNESS!");
  console.log("=".repeat(60) + "\n");
}

main().catch((err: unknown) => {
  console.error("\n❌ SUITE RUN FAILED:", err);
  process.exit(1);
});
