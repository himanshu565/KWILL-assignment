# Encore Tickets — Real-Time Inventory & Checkout Holds API

Production-grade backend service for high-stakes ticketing inventory management with temporary checkout holds, pessimistic concurrency control, idempotent webhook ingestion, and commutative out-of-order state reconciliation.

---

## 1. Stack & Architectural Decisions

* **Language**: **TypeScript (Strict Mode)** — Zero `any`, complete compile-time type safety across database entities, HTTP requests, responses, and domain state machines.
* **Framework**: **Next.js 16 (App Router / Route Handlers)** — High-performance native HTTP route handlers deployed serverless or containerized.
* **Database**: **PostgreSQL 17** — Relational database providing ACID guarantees, row-level pessimistic locking (`FOR UPDATE`), conditional inserts (`INSERT ... SELECT ... WHERE`), and partial indexes.
* **Driver**: **`pg` (node-postgres)** with explicit transaction lifecycle (`BEGIN` / `COMMIT` / `ROLLBACK`).

### Why this stack?
1. **Deriving Availability from the Ledger**: Instead of maintaining an error-prone counter column that easily desynchronizes under concurrent crashes, available inventory is **derived directly from relational truth**:
   $$\text{Available} = \text{Total Inventory} - \text{Active Holds} - \text{Paid Orders}$$
2. **Deterministic Mutual Exclusion**: Ticketing demand exhibits high write contention on the same tier record (e.g. 500 users vying for the final 5 VIP tickets). A pessimistic row lock on the target `tiers` record guarantees serialized inventory checks with sub-millisecond execution times and zero phantom allocations.

---

## 2. Database Schema & Relational Architecture

```
                    ┌────────────────────────┐
                    │         events         │
                    ├────────────────────────┤
                    │ id (PK, text)          │
                    │ title (text)           │
                    │ venue (text)           │
                    │ starts_at (timestamptz)│
                    └───────────┬────────────┘
                                │ 1
                                │
                                │ N
                    ┌───────────▼────────────┐
                    │         tiers          │
                    ├────────────────────────┤
                    │ id (PK, text)          │
                    │ event_id (FK -> events)│
                    │ name (text)            │
                    │ price (int, minor units│
                    │ currency (varchar 3)   │
                    │ total_inventory (int)  │
                    └───────┬────────┬───────┘
                            │        │
                  ┌─────────┘        └─────────┐
                  │ 1                          │ 1
                  │ N                          │ N
       ┌──────────▼─────────────┐   ┌──────────▼─────────────┐
       │         holds          │   │         orders         │
       ├────────────────────────┤   ├────────────────────────┤
       │ id (PK, text)          │   │ id (PK, external id)   │
       │ tier_id (FK -> tiers)  │   │ tier_id (FK -> tiers)  │
       │ quantity (int > 0)     │   │ quantity (int > 0)     │
       │ expires_at (timestamp) │   │ status (paid/refunded) │
       │ status (enum)          │   │ amount_total (int)     │
       │ converted_order_id (FK)├───┤ amount_refunded (int)  │
       └────────────────────────┘   │ paid_at (timestamptz)  │
                                    └────────────────────────┘

                    ┌────────────────────────┐
                    │     webhook_events     │
                    ├────────────────────────┤
                    │ id (PK, idempotency_key│
                    │ event_type (text)      │
                    │ payload (jsonb)        │
                    │ received_at (timestamp)│
                    │ processed_at (timestam)│
                    └────────────────────────┘
```

### Key Schema Design & Indexes
* **`holds.converted_order_id`**: Foreign key to `orders.id` ensuring data integrity when converting holds to completed purchases.
* **Consistency Constraint**:
  ```sql
  CONSTRAINT holds_converted_consistency CHECK (
    (status = 'converted' AND converted_order_id IS NOT NULL) OR
    (status <> 'converted' AND converted_order_id IS NULL)
  )
  ```
* **Performance Partial Indexes**:
  * `CREATE INDEX holds_tier_active_idx ON holds (tier_id) WHERE status = 'active';` — Accelerates hold summation queries by indexing only active unexpired holds.
  * `CREATE INDEX holds_active_expiry_idx ON holds (expires_at) WHERE status = 'active';` — Accelerates background hold cleanup.
  * `CREATE INDEX orders_tier_paid_idx ON orders (tier_id) WHERE status = 'paid';` — Filters only paid orders when computing available inventory.
  * `CREATE INDEX webhook_events_order_idx ON webhook_events ((payload ->> 'order_id'));` — Enables fast lookup for deferred refund events.

---

## 3. Concurrency & Race-Condition Defense (Scenario C)

### The Overselling Problem
When multiple users request the final ticket at the exact same millisecond:
1. Transaction A reads available inventory = 1.
2. Transaction B reads available inventory = 1.
3. Transaction A creates hold (held = 1).
4. Transaction B creates hold (held = 2) -> **OVERSELLING BUG**.

### Our Solution: Pessimistic Tier Serialization
Inside a database transaction (`BEGIN ... COMMIT`):
```sql
-- 1. Exclusively lock the parent tier row
SELECT id FROM tiers WHERE id = $1 AND event_id = $2 FOR UPDATE;

-- 2. Expire any stale holds on-the-fly
UPDATE holds SET status = 'expired' WHERE status = 'active' AND expires_at <= now() AND tier_id = $1;

-- 3. Atomic conditional insert
INSERT INTO holds (id, tier_id, quantity, expires_at, status)
SELECT $1, t.id, $2::integer, now() + ($3::integer * interval '1 second'), 'active'::hold_status
FROM tiers t
WHERE t.id = $4
  AND t.total_inventory
    - COALESCE((SELECT SUM(h.quantity) FROM holds h WHERE h.tier_id = t.id AND h.status = 'active' AND h.expires_at > now()), 0)
    - COALESCE((SELECT SUM(o.quantity) FROM orders o WHERE o.tier_id = t.id AND o.status = 'paid'), 0)
    >= $2::integer
RETURNING id, tier_id, quantity, expires_at, status;
```

#### Why `FOR UPDATE` on `tiers` instead of table locking or optimistic retry loops?
1. **Tier-level Granularity**: Locking `tier_002_b` never blocks buyers purchasing tickets for `tier_001_a` or another concert.
2. **Zero Deadlocks**: Because transactions lock the tier first in a uniform order before touching `holds`, cycles cannot form.
3. **No Phantom Reads**: Serializes the evaluation of total minus held minus sold, completely eliminating race conditions.
4. **Structured Rejection**: If `INSERT ... SELECT` returns zero rows, the server immediately rolls back and returns HTTP `409 Conflict`:
   ```json
   {
     "error": {
       "code": "OVERSOLD",
       "message": "Not enough tickets left on this tier. Another checkout probably grabbed the last seats."
     }
   }
   ```

---

## 4. Webhook Idempotency & Commutative State Machine

Payment webhooks are inherently at-least-once. The system defends against duplication and out-of-order arrival:

### Scenario B: Webhook Idempotency
1. `event_id` is the primary key of `webhook_events`.
2. Upon receipt:
   ```sql
   INSERT INTO webhook_events (id, event_type, payload, processed_at)
   VALUES ($1, $2, $3::jsonb, now())
   ON CONFLICT (id) DO NOTHING;
   ```
3. If `rowCount === 0`, the event has already been executed. The server fetches the existing order and immediately returns `200 OK` with `duplicate: true`, executing **zero side-effects**.

### Out-of-Order Webhooks (Refund Arrives Before Paid)
A classic distributed systems trap: Network reordering delivers `order.refunded` before `order.paid`.
* **Naive approach**: Fails with 404 or drops the refund. When `order.paid` arrives later, tickets remain permanently deducted.
* **Our Commutative State Machine**:
  1. When `order.refunded` arrives for a non-existent order, it is claimed in `webhook_events` and recorded with `deferred: true`.
  2. When the delayed `order.paid` arrives:
     - It inserts the order.
     - It converts the active hold (freeing the hold).
     - It inspects `webhook_events` for any prior refund for that `order_id` via `applyStoredRefunds()`.
     - It immediately transitions the order status to `refunded`.
  3. **End Result**: Regardless of arrival order:
     $$\text{Apply}(\text{Paid}, \text{Refund}) \equiv \text{Apply}(\text{Refund}, \text{Paid}) \implies \text{Status} = \text{refunded}$$
     Available inventory is fully restored!

---

## 5. Hold Expiration Strategy

Holds feature a **10-minute TTL** (`HOLD_TTL_SECONDS=600`). We utilize a **dual-layer architecture**:

1. **Strict On-Read Evaluation (Zero Lag)**:
   Every availability calculation and hold conversion enforces:
   ```sql
   WHERE status = 'active' AND expires_at > now()
   ```
   Even if an active hold hasn't been swept yet, the moment `expires_at <= now()`, it is mathematically excluded from inventory calculation. This guarantees 100% real-time accuracy without reliance on cron timing.
2. **Opportunistic & Background Sweeping**:
   - `expireStaleHolds()` is triggered during hold creation and read operations.
   - Convenience testing route: `POST /orders/:order_id/cancel-hold` explicitly marks an active hold as `'expired'`, bypassing the 10-minute wait during demos.

---

## 6. REST API Specification

### 1. `GET /events/:event_id`
Returns event details and real-time inventory counts per tier.
```json
{
  "id": "evt_001",
  "title": "Anoushka Shankar — Live in Lisbon",
  "venue": "Coliseu dos Recreios, Lisboa",
  "starts_at": "2026-11-14T20:00:00.000Z",
  "tiers": [
    {
      "id": "tier_001_a",
      "name": "Front Stalls",
      "price": 8500,
      "currency": "EUR",
      "total_inventory": 50,
      "available": 48,
      "held": 2,
      "sold": 0
    }
  ]
}
```

### 2. `POST /events/:event_id/holds`
Creates a temporary hold for `quantity` tickets.
* Request:
  ```json
  { "tier_id": "tier_001_a", "quantity": 2 }
  ```
* Success (201 Created):
  ```json
  {
    "hold_id": "hld_BznzdXnHPXJA",
    "tier_id": "tier_001_a",
    "quantity": 2,
    "expires_at": "2026-09-30T10:37:12.529Z",
    "status": "active"
  }
  ```
* Oversold (409 Conflict):
  ```json
  {
    "error": {
      "code": "OVERSOLD",
      "message": "Not enough tickets left on this tier. Another checkout probably grabbed the last seats."
    }
  }
  ```

### 3. `POST /orders/:order_id/cancel-hold`
Convenience endpoint for testing to explicitly release an active hold.
* Success (200 OK):
  ```json
  {
    "hold_id": "hld_BznzdXnHPXJA",
    "status": "expired",
    "tier_id": "tier_001_a",
    "quantity": 2
  }
  ```

### 4. `POST /webhooks/payments`
Ingests processor webhooks (`order.paid`, `order.refunded`).
* Idempotent response (200 OK):
  ```json
  {
    "received": true,
    "duplicate": false,
    "deferred": false,
    "order": {
      "id": "ord_12345",
      "status": "paid",
      "quantity": 2
    },
    "hold_id": "hld_BznzdXnHPXJA"
  }
  ```

---

## 7. Local Setup & Quickstart

### Prerequisites
* Node.js v20+
* PostgreSQL 16+ (Local, Docker, Neon, or Supabase)

### 1. Environment Configuration
Create a `.env` file in the root directory:
```env
DATABASE_URL=postgres://user:password@localhost:5432/encore
HOLD_TTL_SECONDS=600
API_BASE_URL=http://localhost:3000
```

### 2. Database Migration & Seed
Run migrations to initialize schema and seed mock concert data:
```bash
npm install
npm run db:migrate
npm run db:seed
```
*(To wipe test state cleanly back to initial inventory at any time: `npm run db:reset`)*

### 3. Start Development Server
```bash
npm run dev
```
Open **[http://localhost:3000](http://localhost:3000)** in your browser to access the **Interactive Live Control Plane Dashboard**.

---

## 8. Automated Verification & Testing

### 1. Run Complete Automated Demo Suite
Executes Scenario A, Scenario B, Scenario C, and Out-of-Order resolution end-to-end with structured console output:
```bash
npm run demo
```

### 2. Run Race Condition Test (Scenario C)
Launches concurrent promises fighting for the final Student ticket on `evt_002`:
```bash
npm run scenario:c
```

### 3. Run Automated Integration & Unit Tests
```bash
npm test
```

---

## 9. Interview Presentation & Defense

When presenting this system in the pairing session or 3–5 min Loom video:

### 1. 30-Second Walkthrough of Scenarios A, B, C
* **Scenario A (Happy Path)**: User holds 2 tickets $\rightarrow$ `available` drops from 50 to 48, `held` becomes 2 $\rightarrow$ `order.paid` webhook arrives $\rightarrow$ hold status transitions to `converted` and order is recorded as `paid` $\rightarrow$ `held` returns to 0, `sold` becomes 2, `available` remains 48 without double deduction.
* **Scenario B (Idempotency)**: Retransmitting the exact same `order.paid` webhook hits the primary key uniqueness on `webhook_events`, returns HTTP 200 with `duplicate: true`, and leaves inventory untouched.
* **Scenario C (Concurrency Race)**: Draining the Student tier to 1 ticket and launching 2 simultaneous hold requests results in exactly one HTTP 201 and one structured HTTP 409 `OVERSOLD`.

### 2. One Decision Proud Of, and Why
* **The Commutative Out-of-Order Webhook Resolution**: Rather than returning a retry error (which depends on processor retry schedules) or failing with 404, we persist incoming refunds even when the order has not arrived yet (`deferred: true`). When `order.paid` eventually arrives, it automatically applies the refund in the same transaction. This makes state transitions commutative and resilient to network reordering.

### 3. One Decision to Revisit with Another Half-Day
* **Background Worker Queue for Webhook Processing**: Currently, webhook ingestion processes business logic synchronously inside the HTTP handler. While transactional, under extreme traffic spikes (e.g. 50,000 webhook events/sec during a Taylor Swift ticket drop), offloading webhooks into a durable log (such as PostgreSQL `SKIP LOCKED` job queue or Redis Stream) would provide instant ingestion acknowledgments and decoupled asynchronous worker processing.

### 4. One Clarification Question Wished Answered Up Front
* **Partial Refund Semantics on Ticket Ledger**: The brief defines order statuses as `paid`, `refunded`, and `partially_refunded`, but mock webhook payloads specify minor unit amounts rather than quantity released. How should the business logic determine which seats or quantity to release if an order of 4 tickets is refunded by 50% of its monetary value?
