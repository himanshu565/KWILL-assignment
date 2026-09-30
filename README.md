# Encore Tickets Inventory API

A TypeScript API for ticket inventory, temporary checkout holds, and payment webhooks. It uses Next.js Route Handlers, PostgreSQL, and `pg` transactions.

## Stack

- TypeScript with strict checking
- Next.js 16 App Router and Route Handlers
- PostgreSQL 17
- `pg` with explicit `BEGIN`, `COMMIT`, and `ROLLBACK` transactions
- `nanoid` for hold identifiers

## How inventory works

Inventory is derived from the relational records rather than stored as a mutable counter:

`available = total_inventory - active unexpired holds - paid orders`

A hold transaction locks the requested `tiers` row with `SELECT ... FOR UPDATE`, expires stale holds for that tier, and uses an `INSERT ... SELECT` condition to create the hold only when enough inventory remains. This serializes competing holds for the same tier while leaving other tiers independent.

Reads also sweep stale holds and count only rows where `status = 'active'` and `expires_at > now()`.

## Data model

```text
 events 1 ---- N tiers 1 ---- N holds
                    |
                    +--------- N orders

 webhook_events stores the processor event id, type, and JSON payload.
```

- `events` contains the event and venue details.
- `tiers` contains prices and total inventory.
- `holds` reserves tickets temporarily and can be `active`, `expired`, or `converted`.
- `orders` records paid purchases and refund amounts.
- `webhook_events` provides event-id idempotency and stores deferred refunds.

The database also enforces the relationship between a converted hold and its order, plus partial indexes for active holds, paid orders, and webhook lookup by order id.

## API

### `GET /events/:event_id`

Returns event details and derived inventory for each tier.

### `POST /events/:event_id/holds`

Creates a temporary hold:

```json
{
  "tier_id": "tier_001_a",
  "quantity": 2
}
```

A successful request returns `201` with the hold id, expiration time, quantity, and `active` status. Insufficient inventory returns `409` with an `OVERSOLD` error.

### `POST /orders/:order_id/cancel-hold`

Explicitly expires an active hold. This endpoint is useful for local demonstrations without waiting for the ten-minute hold TTL.

### `POST /webhooks/payments`

Accepts `order.paid` and `order.refunded` events. The `event_id` is claimed atomically, so replaying the same event returns an idempotent response without repeating side effects.

A refund received before its payment is stored as deferred. When the payment arrives, the stored refund is applied in the same transaction, leaving the order in its correct final state.

`partially_refunded` is supported when `amount_refunded` is below `amount_total`. The current webhook contract does not provide a refunded ticket quantity or seat list, so a partial refund updates order status and monetary totals but keeps the full order counted as sold. This avoids releasing all tickets when only part of the payment was refunded.

## Local setup

Requirements: Node.js 20 or newer and PostgreSQL 16 or newer.

Create `.env`:

```env
DATABASE_URL=postgres://user:password@localhost:5432/encore
HOLD_TTL_SECONDS=600
API_BASE_URL=http://localhost:3000
```

Install dependencies, start PostgreSQL, then initialize the schema and seed data:

```bash
npm install
npm run db:up
npm run db:migrate
npm run db:seed
npm run dev
```

The API is available at `http://localhost:3000`. There is no public deployment configured in this repository; set `API_BASE_URL` to the deployed origin when using the scripts against another environment.

To reset hold, order, and webhook state and reseed the events:

```bash
npm run db:reset
```

## Sending test webhooks

The mock processor posts directly to the local webhook route. For a paid event:

```bash
npm run webhook -- paid evt_wh_001 ord_001 tier_001_a 1 8500
```

For a paid event tied to a hold, append the hold id:

```bash
npm run webhook -- paid evt_wh_002 ord_002 tier_001_a 1 8500 hld_example
```

For a refund:

```bash
npm run webhook -- refund evt_wh_003 ord_002 8500
```

The command uses `API_BASE_URL`, which defaults to `http://localhost:3000`.

To demonstrate the happy path, create a hold first, then send a paid webhook with the returned hold id:

```bash
curl -X POST http://localhost:3000/events/evt_001/holds -H "content-type: application/json" -d "{\"tier_id\":\"tier_001_a\",\"quantity\":1}"
npm run webhook -- paid evt_wh_demo ord_demo tier_001_a 1 8500 hld_returned_by_the_first_command
```

To demonstrate idempotency, run the same paid command twice with the same event id and order id. The second response has `duplicate: true` and does not change inventory.

## Repeatable concurrency demo

`scenario:c` drains the Berlin Student tier to one available ticket and sends two hold requests concurrently:

```bash
npm run scenario:c
```

The expected result is one successful hold and one `409 OVERSOLD` response.

## Trade-offs

- Webhook processing is synchronous inside the request transaction. A production deployment could persist the event first and process it with a worker or transactional outbox, but that would add operational components and asynchronous state handling.
- The tier row lock is simple and local to the inventory being changed. It can limit throughput when many requests target one tier, but it keeps the availability check and hold insert in one transaction.
- Partial refunds update order state and amounts but keep the full order counted as sold. Releasing individual tickets would require a contract that identifies refunded quantity or seats.
- No public deployment is included here. Local and self-hosted deployments can use the same route handlers with a PostgreSQL connection string.
