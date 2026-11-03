-- Applied automatically on startup (idempotent).

CREATE TABLE IF NOT EXISTS conversations (
  phone          text PRIMARY KEY,
  customer_name  text,
  messages       jsonb NOT NULL DEFAULT '[]',
  cart           jsonb NOT NULL DEFAULT '[]',
  pickup_note    text,
  human_until    timestamptz,
  opted_out      boolean NOT NULL DEFAULT false,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS orders (
  id                text PRIMARY KEY,
  phone             text NOT NULL,
  order_number      integer NOT NULL,
  square_order_id   text NOT NULL UNIQUE,
  payment_link_id   text NOT NULL,
  payment_link_url  text NOT NULL,
  total_cents       integer NOT NULL,
  currency          text NOT NULL,
  summary           text NOT NULL,
  status            text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  paid_at           timestamptz,
  ready_at          timestamptz
);
CREATE INDEX IF NOT EXISTS orders_phone_status ON orders (phone, status);
CREATE INDEX IF NOT EXISTS orders_status_created ON orders (status, created_at);

CREATE TABLE IF NOT EXISTS settings (
  key    text PRIMARY KEY,
  value  text NOT NULL
);

CREATE TABLE IF NOT EXISTS processed_events (
  id          text PRIMARY KEY,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Order numbers restart at 1 each day (local business date), like a ticket roll.
CREATE TABLE IF NOT EXISTS order_counters (
  day   date PRIMARY KEY,
  last  integer NOT NULL
);
