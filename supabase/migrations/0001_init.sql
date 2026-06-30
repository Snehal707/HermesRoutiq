-- HermesRoutiq initial schema (Phase 3)
-- Run via: npm run db:migrate (requires DATABASE_URL in apps/web/.env.local)

CREATE TABLE IF NOT EXISTS pickup_hubs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  lat DOUBLE PRECISION NOT NULL,
  lng DOUBLE PRECISION NOT NULL
);

CREATE TABLE IF NOT EXISTS customer_locations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  lat DOUBLE PRECISION NOT NULL,
  lng DOUBLE PRECISION NOT NULL
);

CREATE TABLE IF NOT EXISTS drivers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  vehicle_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vehicles (
  id TEXT PRIMARY KEY,
  driver_id TEXT NOT NULL REFERENCES drivers(id),
  route JSONB NOT NULL DEFAULT '[]'::jsonb,
  route_status TEXT NOT NULL DEFAULT 'normal',
  status TEXT NOT NULL DEFAULT 'en_route',
  speed_mps DOUBLE PRECISION NOT NULL DEFAULT 8,
  frozen_at_seconds DOUBLE PRECISION
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customer_locations(id),
  pickup_hub_id TEXT NOT NULL REFERENCES pickup_hubs(id),
  vehicle_id TEXT NOT NULL REFERENCES vehicles(id),
  status TEXT NOT NULL DEFAULT 'in_transit',
  revenue_cents INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS incidents (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  vehicle_id TEXT NOT NULL REFERENCES vehicles(id),
  order_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at_sim_seconds DOUBLE PRECISION NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id TEXT REFERENCES incidents(id),
  reasoning_summary TEXT,
  options JSONB,
  selected_option JSONB,
  expected_cost_cents INTEGER,
  expected_benefit_cents INTEGER,
  policy_result TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_type TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  reference_id TEXT,
  idempotency_key TEXT UNIQUE,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS simulation_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  sim_seconds DOUBLE PRECISION,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS customer_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id TEXT REFERENCES orders(id),
  channel TEXT NOT NULL,
  message TEXT NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS policy_evaluations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action_type TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  allowed BOOLEAN NOT NULL,
  reason TEXT,
  incident_id TEXT REFERENCES incidents(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
