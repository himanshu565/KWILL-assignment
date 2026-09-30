# Encore Tickets — Interview Pairing & Loom Video Cheat Sheet

Use this guide to record your 3–5 minute Loom video and prepare for the 90-minute live pairing session with Kanav and the Kwill engineering team.

---

## 📹 Part 1: 3–5 Minute Loom Video Script

### [0:00 – 0:30] Introduction & Architecture Summary
* **What to show**: Terminal requests against `http://localhost:3000` (or your deployed URL).
* **What to say**:
  > *"Hi Kanav and the Kwill team, this is my submission for the Encore Tickets backend developer role. I built the inventory API using Next.js 16 Route Handlers in strict TypeScript, backed by PostgreSQL 17. The core architectural philosophy here is that availability is never maintained as a mutable counter column; instead, it is derived directly from the relational ledger: Total Inventory minus Active Holds minus Paid Orders. Let's walk through the three core scenarios and edge cases."*

---

### [0:30 – 1:45] The 30-Second Demos (Scenarios A, B, C & Out-of-Order)

#### 1. Scenario A — Happy Path
* **What to run**: Create a hold with `POST /events/evt_001/holds`, then send an `order.paid` webhook with `npm run webhook` and the returned hold id.
* **What to explain**:
  > *"In Scenario A, the user adds 2 General Standing tickets to cart. The API creates a hold with a 10-minute TTL. Available inventory drops from 200 to 197, while Held increases to 3. Then, the mock payment processor delivers the `order.paid` webhook. The system atomically transitions the hold to `converted` and records the order as `paid`. As you can see, Held returns to 0, Sold becomes 3, and Available remains 197 — zero double-deduction."*

#### 2. Scenario B — Idempotent Webhook Delivery
* **What to run**: Send the same `npm run webhook` paid command twice with the same `event_id` and `order_id`.
* **What to explain**:
  > *"In Scenario B, the payment processor retries and delivers the exact same `order.paid` webhook twice. Our backend uses `event_id` as the primary key of the `webhook_events` table with atomic `ON CONFLICT DO NOTHING`. The second request returns HTTP 200 with `duplicate: true`, executing zero side-effects. The available inventory remains completely untouched."*

#### 3. Scenario C — Concurrency Race Condition
* **What to run**: Run `npm run scenario:c` after seeding the database.
* **What to explain**:
  > *"In Scenario C, we drain the Student tier down to exactly 1 remaining ticket and fire two simultaneous hold requests at the exact same millisecond. Using PostgreSQL row-level pessimistic locking (`SELECT ... FOR UPDATE` on the parent tier), the transaction serializes inventory checks. Exactly one request succeeds with HTTP 201 Created, while the other is safely rejected with HTTP 409 and a structured `OVERSOLD` error. No tickets are oversold."*

#### 4. Out-of-Order Webhook Delivery (Refund before Paid)
* **What to run**: Send a refund with `npm run webhook` before sending the matching paid webhook.
* **What to explain**:
  > *"Because networks reorder packets, a refund can arrive before the payment webhook. When `order.refunded` arrives first, we claim it in `webhook_events` as deferred. When the delayed `order.paid` arrives later, our system creates the order and immediately reconciles the deferred refund in the same transaction. The order ends as `refunded` and the tickets are restored to available inventory."*

---

### [1:45 – 3:00] The 3 Required Reflection Questions

#### 1. One decision I'm proud of, and why
> *"The decision I'm most proud of is the commutative state machine for out-of-order webhooks. Many backends either return a 404 or an arbitrary 500 when receiving an orphan refund, relying on the payment processor's retry backoff. By persisting the refund event immediately and replaying it atomically upon the delayed payment's arrival, the final state is deterministic regardless of delivery order: `Apply(Paid, Refund) == Apply(Refund, Paid)`."*

#### 2. One decision I'd revisit with another half-day
> *"If I had another half-day, I would decouple webhook ingestion from business logic execution using a transactional outbox / worker pattern. Right now, webhooks run synchronously inside the Route Handler. In high-throughput flash-sale spikes, saving the raw webhook to a durable queue and returning an instant 200 acknowledgement would isolate database connection pool spikes from the payment processor."*

#### 3. One question I wish had been answered up front
> *"I wish the prompt clarified how partial refunds map to ticket quantities. The schema includes a `partially_refunded` status, and the mock webhook passes `amount_refunded` in cents without specifying which tickets or how many seats are being released. Having a business rule for fractional inventory restoration would make partial refund reconciliation explicit."*

---

## 🧠 Part 2: Technical Q&A for the 90-Minute Live Pairing Session

### Q1: "Why did you use `SELECT ... FOR UPDATE` on the `tiers` table instead of an advisory lock or SERIALIZABLE transaction?"
* **Answer**:
  > *"Advisory locks introduce out-of-band state and risk leaks if connection pooling isn't carefully managed. `SERIALIZABLE` isolation works via optimistic concurrency and predicate locking; under heavy contention (like a ticket drop), it throws `40001 serialization_failure`, forcing high client retry rates and wasted CPU cycles. By using `SELECT ... FOR UPDATE` on the specific `tier` record, we achieve clean pessimistic serialization scoped only to that tier for just a couple of milliseconds. Other tiers and concerts are never blocked."*

### Q2: "Can this cause deadlocks?"
* **Answer**:
  > *"No, because resource acquisition is strictly hierarchical and single-object. Every transaction touches the parent `tiers` row first before reading or modifying `holds`. Because all transactions acquire locks in the exact same order (tiers $\rightarrow$ holds $\rightarrow$ orders), lock dependency cycles cannot form, completely preventing deadlocks."*

### Q3: "How does the system ensure expired holds don't block inventory if the background sweeper is delayed?"
* **Answer**:
  > *"We use an on-read strategy. Every availability query and hold creation query includes `WHERE status = 'active' AND expires_at > now()`, and API requests opportunistically mark stale rows as expired. Even if the stored status has not been swept yet, an expired hold is excluded from inventory calculation."*

### Q4: "What happens if a database connection drops in the middle of processing a webhook?"
* **Answer**:
  > *"Every webhook execution runs inside `withTransaction((client) => ...)`. If any error or connection drop occurs before `COMMIT`, PostgreSQL rolls back the entire transaction. The `webhook_events` record is not saved, and the Route Handler returns a 500 error, signaling to the payment gateway to retry the webhook safely."*

### Q5: "How does this design scale to 50,000 requests per second?"
* **Answer**:
  > *"For massive scale drops:
  > 1. Read Path: Cache the `GET /events/:id` responses in Redis or at the CDN edge with a 1-second TTL or cache invalidation on write.
  > 2. Write Path: Use a distributed token bucket or Redis Lua script (`DECRBY`) to grant hold reservation tokens, falling back to PostgreSQL for ACID durability.
  > 3. Webhook Path: Webhook handler directly enqueues payloads into a Kafka topic or RabbitMQ queue, processed by worker pools using PostgreSQL `SKIP LOCKED` batch inserts."*
