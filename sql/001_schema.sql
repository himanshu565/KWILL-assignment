-- Encore Tickets inventory: holds during checkout, orders from the processor.
-- Availability is derived: total_inventory - active unexpired holds - paid orders.

DO $$ BEGIN
  CREATE TYPE hold_status AS ENUM ('active', 'expired', 'converted');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE order_status AS ENUM ('paid', 'refunded', 'partially_refunded');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  venue TEXT NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS tiers (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  price INTEGER NOT NULL CHECK (price >= 0),
  currency VARCHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  total_inventory INTEGER NOT NULL CHECK (total_inventory >= 0)
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  tier_id TEXT NOT NULL REFERENCES tiers (id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  status order_status NOT NULL,
  amount_total INTEGER NOT NULL CHECK (amount_total >= 0),
  amount_refunded INTEGER NOT NULL DEFAULT 0 CHECK (amount_refunded >= 0 AND amount_refunded <= amount_total),
  currency VARCHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  paid_at TIMESTAMPTZ,
  refunded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS holds (
  id TEXT PRIMARY KEY,
  tier_id TEXT NOT NULL REFERENCES tiers (id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  expires_at TIMESTAMPTZ NOT NULL,
  status hold_status NOT NULL DEFAULT 'active',
  converted_order_id TEXT REFERENCES orders (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT holds_converted_consistency CHECK (
    (status = 'converted' AND converted_order_id IS NOT NULL)
    OR (status <> 'converted' AND converted_order_id IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS webhook_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS holds_tier_active_idx ON holds (tier_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS holds_active_expiry_idx ON holds (expires_at)
  WHERE status = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS holds_converted_order_uidx ON holds (converted_order_id)
  WHERE converted_order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS orders_tier_paid_idx ON orders (tier_id)
  WHERE status IN ('paid', 'partially_refunded');

CREATE INDEX IF NOT EXISTS webhook_events_order_idx ON webhook_events ((payload ->> 'order_id'));
CREATE INDEX IF NOT EXISTS webhook_events_type_idx ON webhook_events (event_type);
