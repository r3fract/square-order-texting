import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { newConversation, type Conversation, type OrderRecord, type Store } from "./types.js";

type Row = Record<string, any>;
const json = (v: unknown) => (v == null ? null : JSON.stringify(v));

function toConversation(r: Row): Conversation {
  return {
    phone: r.phone,
    customerName: r.customer_name,
    messages: r.messages,
    cart: r.cart,
    pickupNote: r.pickup_note,
    humanUntil: r.human_until,
    optedOut: r.opted_out,
    updatedAt: r.updated_at,
    squareCustomerId: r.square_customer_id ?? null,
    customerAmbiguous: r.customer_ambiguous ?? false,
    customerLookupAt: r.customer_lookup_at ?? null,
    savedCard: r.saved_card ?? null,
    savedCards: r.saved_cards ?? [],
    pendingOneTap: r.pending_one_tap ? { ...r.pending_one_tap, offeredAt: new Date(r.pending_one_tap.offeredAt) } : null,
    cardOfferMadeAt: r.card_offer_made_at ?? null,
    pickupTarget: r.pickup_target ?? null,
    loyaltyAccountId: r.loyalty_account_id ?? null,
    loyaltyBalance: r.loyalty_balance ?? null,
    pendingRewardTierId: r.pending_reward_tier_id ?? null,
  };
}

function toOrder(r: Row): OrderRecord {
  return {
    id: r.id,
    phone: r.phone,
    orderNumber: r.order_number,
    squareOrderId: r.square_order_id,
    paymentLinkId: r.payment_link_id,
    paymentLinkUrl: r.payment_link_url,
    totalCents: r.total_cents,
    currency: r.currency,
    summary: r.summary,
    status: r.status,
    createdAt: r.created_at,
    paidAt: r.paid_at,
    readyAt: r.ready_at,
    checkoutKind: r.checkout_kind,
    invoiceId: r.invoice_id,
    invoiceVersion: r.invoice_version,
    squarePaymentId: r.square_payment_id,
    customerId: r.customer_id,
    cart: r.cart,
    pickupAt: r.pickup_at,
    pickupSlot: r.pickup_slot,
    quotedReadyAt: r.quoted_ready_at,
    etaNotifiedAt: r.eta_notified_at,
    loyaltyRewardId: r.loyalty_reward_id ?? null,
  };
}

const ORDER_COLS: Record<keyof OrderRecord, string> = {
  id: "id",
  phone: "phone",
  orderNumber: "order_number",
  squareOrderId: "square_order_id",
  paymentLinkId: "payment_link_id",
  paymentLinkUrl: "payment_link_url",
  totalCents: "total_cents",
  currency: "currency",
  summary: "summary",
  status: "status",
  createdAt: "created_at",
  paidAt: "paid_at",
  readyAt: "ready_at",
  checkoutKind: "checkout_kind",
  invoiceId: "invoice_id",
  invoiceVersion: "invoice_version",
  squarePaymentId: "square_payment_id",
  customerId: "customer_id",
  cart: "cart",
  pickupAt: "pickup_at",
  pickupSlot: "pickup_slot",
  quotedReadyAt: "quoted_ready_at",
  etaNotifiedAt: "eta_notified_at",
  loyaltyRewardId: "loyalty_reward_id",
};

/** jsonb columns need JSON text; everything else goes to pg as-is. */
const orderValue = (k: keyof OrderRecord, v: unknown) => (k === "cart" ? JSON.stringify(v) : v);

export class PostgresStore implements Store {
  private pool: pg.Pool;
  constructor(
    connectionString: string,
    private timezone: string,
  ) {
    this.pool = new pg.Pool({ connectionString });
  }

  async migrate() {
    const sqlPath = fileURLToPath(new URL("../../sql/schema.sql", import.meta.url));
    const sql = await readFile(sqlPath, "utf8");
    // Serialise migrations: concurrent CREATE/ALTER on the same tables fail in Postgres.
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(727274)");
      await client.query(sql);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async close() {
    await this.pool.end();
  }

  async getConversation(phone: string) {
    const { rows } = await this.pool.query("SELECT * FROM conversations WHERE phone = $1", [phone]);
    return rows[0] ? toConversation(rows[0]) : newConversation(phone);
  }

  async saveConversation(c: Conversation) {
    await this.pool.query(
      `INSERT INTO conversations (phone, customer_name, messages, cart, pickup_note, human_until, opted_out, updated_at,
         square_customer_id, customer_ambiguous, customer_lookup_at, saved_card, pending_one_tap, card_offer_made_at, pickup_target, loyalty_account_id,
         loyalty_balance, pending_reward_tier_id, saved_cards)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       ON CONFLICT (phone) DO UPDATE SET customer_name=$2, messages=$3, cart=$4, pickup_note=$5, human_until=$6, opted_out=$7, updated_at=$8,
         square_customer_id=$9, customer_ambiguous=$10, customer_lookup_at=$11, saved_card=$12, pending_one_tap=$13, card_offer_made_at=$14, pickup_target=$15, loyalty_account_id=$16,
         loyalty_balance=$17, pending_reward_tier_id=$18, saved_cards=$19`,
      [c.phone, c.customerName, JSON.stringify(c.messages), JSON.stringify(c.cart), c.pickupNote, c.humanUntil, c.optedOut, c.updatedAt,
       c.squareCustomerId, c.customerAmbiguous, c.customerLookupAt, json(c.savedCard), json(c.pendingOneTap), c.cardOfferMadeAt, json(c.pickupTarget), c.loyaltyAccountId,
       c.loyaltyBalance, c.pendingRewardTierId, JSON.stringify(c.savedCards ?? [])],
    );
  }

  async listConversations(limit: number) {
    const { rows } = await this.pool.query("SELECT * FROM conversations ORDER BY updated_at DESC LIMIT $1", [limit]);
    return rows.map(toConversation);
  }

  async createOrder(o: OrderRecord) {
    const keys = Object.keys(ORDER_COLS) as (keyof OrderRecord)[];
    const cols = keys.map((k) => ORDER_COLS[k]);
    await this.pool.query(
      `INSERT INTO orders (${cols.join(",")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(",")})`,
      keys.map((k) => orderValue(k, o[k])),
    );
  }

  async updateOrder(id: string, patch: Partial<OrderRecord>) {
    const keys = (Object.keys(patch) as (keyof OrderRecord)[]).filter((k) => k !== "id");
    if (keys.length === 0) return;
    const sets = keys.map((k, i) => `${ORDER_COLS[k]} = $${i + 2}`);
    await this.pool.query(`UPDATE orders SET ${sets.join(", ")} WHERE id = $1`, [id, ...keys.map((k) => orderValue(k, patch[k]))]);
  }

  async transitionOrder(id: string, from: OrderRecord["status"][], patch: Partial<OrderRecord>) {
    const keys = (Object.keys(patch) as (keyof OrderRecord)[]).filter((k) => k !== "id");
    const sets = keys.map((k, i) => `${ORDER_COLS[k]} = $${i + 3}`);
    const { rows } = await this.pool.query(
      `UPDATE orders SET ${sets.join(", ")} WHERE id = $1 AND status = ANY($2::text[]) RETURNING *`,
      [id, from, ...keys.map((k) => orderValue(k, patch[k]))],
    );
    return rows[0] ? toOrder(rows[0]) : null;
  }

  async getOrderBySquareId(squareOrderId: string) {
    const { rows } = await this.pool.query("SELECT * FROM orders WHERE square_order_id = $1", [squareOrderId]);
    return rows[0] ? toOrder(rows[0]) : null;
  }

  async getAwaitingOrderForPhone(phone: string) {
    const { rows } = await this.pool.query(
      "SELECT * FROM orders WHERE phone = $1 AND status = 'awaiting_payment' ORDER BY created_at DESC LIMIT 1",
      [phone],
    );
    return rows[0] ? toOrder(rows[0]) : null;
  }

  async listAwaitingCreatedBefore(before: Date) {
    const { rows } = await this.pool.query("SELECT * FROM orders WHERE status = 'awaiting_payment' AND created_at < $1", [before]);
    return rows.map(toOrder);
  }

  async listOrders(limit: number) {
    const { rows } = await this.pool.query("SELECT * FROM orders ORDER BY created_at DESC LIMIT $1", [limit]);
    return rows.map(toOrder);
  }

  async countActiveOrders() {
    const { rows } = await this.pool.query("SELECT count(*)::int AS n FROM orders WHERE status = 'paid'");
    return rows[0].n as number;
  }

  async countOrdersInSlot(slotKey: string) {
    const { rows } = await this.pool.query(
      "SELECT count(*)::int AS n FROM orders WHERE pickup_slot = $1 AND status IN ('paid','awaiting_payment')",
      [slotKey],
    );
    return rows[0].n as number;
  }

  async listOrdersInSlotPrefix(prefix: string) {
    const { rows } = await this.pool.query("SELECT * FROM orders WHERE starts_with(pickup_slot, $1)", [prefix]);
    return rows.map(toOrder);
  }

  async lastPaidOrderForPhone(phone: string) {
    const { rows } = await this.pool.query(
      "SELECT * FROM orders WHERE phone = $1 AND status IN ('paid','ready','picked_up') ORDER BY created_at DESC LIMIT 1",
      [phone],
    );
    return rows[0] ? toOrder(rows[0]) : null;
  }

  async countActiveAsapOrders(now: Date) {
    const { rows } = await this.pool.query(
      "SELECT count(*)::int AS n FROM orders WHERE status = 'paid' AND (pickup_at IS NULL OR pickup_at <= $1)",
      [now],
    );
    return rows[0].n as number;
  }

  async listCardOrdersSince(phone: string, since: Date) {
    const { rows } = await this.pool.query(
      "SELECT * FROM orders WHERE phone = $1 AND checkout_kind = 'card_on_file' AND created_at >= $2 ORDER BY created_at DESC",
      [phone, since],
    );
    return rows.map(toOrder);
  }

  async nextOrderNumber() {
    const { rows } = await this.pool.query(
      `INSERT INTO order_counters (day, last) VALUES ((now() AT TIME ZONE $1)::date, 1)
       ON CONFLICT (day) DO UPDATE SET last = order_counters.last + 1
       RETURNING last`,
      [this.timezone],
    );
    return rows[0].last as number;
  }

  async getSetting(key: string) {
    const { rows } = await this.pool.query("SELECT value FROM settings WHERE key = $1", [key]);
    return rows[0]?.value ?? null;
  }

  async setSetting(key: string, value: string) {
    await this.pool.query(
      "INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = $2",
      [key, value],
    );
  }

  async claimEvent(id: string) {
    const res = await this.pool.query("INSERT INTO processed_events (id) VALUES ($1) ON CONFLICT DO NOTHING", [id]);
    return res.rowCount === 1;
  }

  async releaseEvent(id: string) {
    await this.pool.query("DELETE FROM processed_events WHERE id = $1", [id]);
  }
}
