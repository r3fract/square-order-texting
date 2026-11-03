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

-- Game-night ordering: customers, saved cards, pickup slots (idempotent).
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS square_customer_id text;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS customer_ambiguous boolean NOT NULL DEFAULT false;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS customer_lookup_at timestamptz;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS saved_card jsonb;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS pending_one_tap jsonb;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS card_offer_made_at timestamptz;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS pickup_target jsonb;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS loyalty_account_id text;

ALTER TABLE orders ALTER COLUMN payment_link_id DROP NOT NULL;
ALTER TABLE orders ALTER COLUMN payment_link_url DROP NOT NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS checkout_kind text NOT NULL DEFAULT 'link';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS invoice_id text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS invoice_version integer;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS square_payment_id text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_id text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cart jsonb NOT NULL DEFAULT '[]';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS pickup_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS pickup_slot text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS quoted_ready_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS eta_notified_at timestamptz;
CREATE INDEX IF NOT EXISTS orders_slot ON orders (pickup_slot, status);
