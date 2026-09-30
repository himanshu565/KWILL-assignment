INSERT INTO events (id, title, venue, starts_at) VALUES
  (
    'evt_001',
    'Anoushka Shankar — Live in Lisbon',
    'Coliseu dos Recreios, Lisboa',
    '2026-11-14T20:00:00Z'
  ),
  (
    'evt_002',
    'Indie Devs Meetup — Berlin',
    'Festsaal Kreuzberg, Berlin',
    '2026-08-22T19:30:00Z'
  )
ON CONFLICT (id) DO UPDATE SET
  title = EXCLUDED.title,
  venue = EXCLUDED.venue,
  starts_at = EXCLUDED.starts_at;

INSERT INTO tiers (id, event_id, name, price, currency, total_inventory) VALUES
  ('tier_001_a', 'evt_001', 'Front Stalls', 8500, 'EUR', 50),
  ('tier_001_b', 'evt_001', 'General Standing', 4500, 'EUR', 200),
  ('tier_001_c', 'evt_001', 'Balcony', 3000, 'EUR', 100),
  ('tier_002_a', 'evt_002', 'Standard', 1500, 'EUR', 80),
  ('tier_002_b', 'evt_002', 'Student', 800, 'EUR', 20)
ON CONFLICT (id) DO UPDATE SET
  event_id = EXCLUDED.event_id,
  name = EXCLUDED.name,
  price = EXCLUDED.price,
  currency = EXCLUDED.currency,
  total_inventory = EXCLUDED.total_inventory;
