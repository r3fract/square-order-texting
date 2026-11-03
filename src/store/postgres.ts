import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { newConversation, type Conversation, type OrderRecord, type Store } from "./types.js";

type Row = Record<string, any>;

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
};

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
    await this.pool.query(await readFile(sqlPath, "utf8"));
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
      `INSERT INTO conversations (phone, customer_name, messages, cart, pickup_note, human_until, opted_out, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (phone) DO UPDATE SET customer_name=$2, messages=$3, cart=$4, pickup_note=$5, human_until=$6, opted_out=$7, updated_at=$8`,
      [c.phone, c.customerName, JSON.stringify(c.messages), JSON.stringify(c.cart), c.pickupNote, c.humanUntil, c.optedOut, c.updatedAt],
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
      keys.map((k) => o[k]),
    );
  }

  async updateOrder(id: string, patch: Partial<OrderRecord>) {
    const keys = (Object.keys(patch) as (keyof OrderRecord)[]).filter((k) => k !== "id");
    if (keys.length === 0) return;
    const sets = keys.map((k, i) => `${ORDER_COLS[k]} = $${i + 2}`);
    await this.pool.query(`UPDATE orders SET ${sets.join(", ")} WHERE id = $1`, [id, ...keys.map((k) => patch[k])]);
  }

  async transitionOrder(id: string, from: OrderRecord["status"][], patch: Partial<OrderRecord>) {
    const keys = (Object.keys(patch) as (keyof OrderRecord)[]).filter((k) => k !== "id");
    const sets = keys.map((k, i) => `${ORDER_COLS[k]} = $${i + 3}`);
    const { rows } = await this.pool.query(
      `UPDATE orders SET ${sets.join(", ")} WHERE id = $1 AND status = ANY($2::text[]) RETURNING *`,
      [id, from, ...keys.map((k) => patch[k])],
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
