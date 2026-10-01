## Deployment

The API is deployed on Vercel:

https://kwill-assignment.vercel.app

PostgreSQL is hosted separately. `DATABASE_URL` and `HOLD_TTL_SECONDS` are
configured as Vercel environment variables, and the database schema and seed
data have been initialized.

## Stack and rationale

- TypeScript with strict checking for type-safe API and database code.
- Next.js App Router Route Handlers for lightweight HTTP endpoints that deploy
  directly to Vercel.
- PostgreSQL for transactional inventory updates, row locking, constraints,
  indexes, and reliable webhook idempotency.
- `pg` for explicit `BEGIN`, `COMMIT`, and `ROLLBACK` transaction control.
- `nanoid` for compact hold identifiers.

## Schema diagram

```text
events 1 ---- N tiers 1 ---- N holds
                    |
                    +--------- N orders

webhook_events stores payment event ids, types, and JSON payloads.
```

- `events` stores event and venue details.
- `tiers` stores ticket prices and total inventory.
- `holds` stores temporary reservations and their status.
- `orders` stores paid purchases and refund amounts.
- `webhook_events` provides payment-event idempotency and deferred refunds.

## Running locally

Requirements: Node.js 20 or newer and Docker.

Create a local `.env` file:

```env
DATABASE_URL=postgres://encore:encore@localhost:5432/encore
HOLD_TTL_SECONDS=600
API_BASE_URL=http://localhost:3000
```

Use a local PostgreSQL connection string that matches the database created by
your Docker setup. Then run:

```bash
npm install
npm run db:up
npm run db:migrate
npm run db:seed
npm run dev
```

The local API runs at `http://localhost:3000`.

## Sending test webhooks

The mock processor sends requests to `API_BASE_URL`. For a payment:

```bash
npm run webhook -- paid evt_wh_001 ord_001 tier_001_a 1 8500
```

For a payment linked to a hold:

```bash
npm run webhook -- paid evt_wh_002 ord_002 tier_001_a 1 8500 hld_example
```

For a refund:

```bash
npm run webhook -- refund evt_wh_003 ord_002 8500
```

To send requests to the deployed API instead:

```bash
API_BASE_URL=https://kwill-assignment.vercel.app
npm run webhook -- paid evt_wh_demo ord_demo tier_001_a 1 8500
```

On Windows PowerShell, set the variable with:

```powershell
$env:API_BASE_URL="https://kwill-assignment.vercel.app"
npm run webhook -- paid evt_wh_demo ord_demo tier_001_a 1 8500
```

Repeating the same event id demonstrates idempotency: the second request
returns `duplicate: true` without repeating the payment side effects.

## Trade-offs

- Webhook processing is synchronous inside the database transaction. A
  production system could use a transactional outbox and worker, but that adds
  operational complexity.
- Inventory is derived from active holds and paid orders instead of a mutable
  counter. This avoids counter drift, while row locking serializes competing
  holds for the same tier.
- Partial refunds update order status and monetary totals but keep the full
  order counted as sold because the webhook contract does not identify refunded
  ticket quantities or seats.
- Docker is used for local PostgreSQL only. Vercel runs the Next.js API, while
  production PostgreSQL is hosted separately.
