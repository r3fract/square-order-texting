import { newConversation, type Conversation, type OrderRecord, type Store } from "./types.js";

/** In-memory store for tests and local dev. Data is lost on restart. */
export class MemoryStore implements Store {
  conversations = new Map<string, Conversation>();
  orders = new Map<string, OrderRecord>();
  settings = new Map<string, string>();
  events = new Set<string>();
  private orderSeq = 0;

  async getConversation(phone: string) {
    const c = this.conversations.get(phone);
    return c ? structuredClone(c) : newConversation(phone);
  }
  async saveConversation(c: Conversation) {
    this.conversations.set(c.phone, structuredClone(c));
  }
  async listConversations(limit: number) {
    return [...this.conversations.values()].sort((a, b) => +b.updatedAt - +a.updatedAt).slice(0, limit);
  }
  async createOrder(o: OrderRecord) {
    this.orders.set(o.id, { ...o });
  }
  async updateOrder(id: string, patch: Partial<OrderRecord>) {
    const o = this.orders.get(id);
    if (o) this.orders.set(id, { ...o, ...patch });
  }
  async transitionOrder(id: string, from: OrderRecord["status"][], patch: Partial<OrderRecord>) {
    const o = this.orders.get(id);
    if (!o || !from.includes(o.status)) return null;
    const next = { ...o, ...patch };
    this.orders.set(id, next);
    return { ...next };
  }
  async getOrderBySquareId(squareOrderId: string) {
    return [...this.orders.values()].find((o) => o.squareOrderId === squareOrderId) ?? null;
  }
  async getAwaitingOrderForPhone(phone: string) {
    return [...this.orders.values()].find((o) => o.phone === phone && o.status === "awaiting_payment") ?? null;
  }
  async listAwaitingCreatedBefore(before: Date) {
    return [...this.orders.values()].filter((o) => o.status === "awaiting_payment" && o.createdAt < before);
  }
  async listOrders(limit: number) {
    return [...this.orders.values()].sort((a, b) => +b.createdAt - +a.createdAt).slice(0, limit);
  }
  async countActiveOrders() {
    return [...this.orders.values()].filter((o) => o.status === "paid").length;
  }
  async nextOrderNumber() {
    return ++this.orderSeq;
  }
  async getSetting(key: string) {
    return this.settings.get(key) ?? null;
  }
  async setSetting(key: string, value: string) {
    this.settings.set(key, value);
  }
  async claimEvent(id: string) {
    if (this.events.has(id)) return false;
    this.events.add(id);
    return true;
  }
  async releaseEvent(id: string) {
    this.events.delete(id);
  }
}
