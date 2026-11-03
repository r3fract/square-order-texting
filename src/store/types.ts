export interface CartLine {
  variationId: string;
  quantity: number;
  modifierIds: string[];
  note?: string;
}

/** A message in the model conversation, stored as Anthropic message params. */
export type StoredMessage = { role: "user" | "assistant"; content: unknown };

export interface Conversation {
  phone: string;
  customerName: string | null;
  messages: StoredMessage[];
  cart: CartLine[];
  pickupNote: string | null;
  humanUntil: Date | null; // bot stays quiet for this customer until this time
  optedOut: boolean;
  updatedAt: Date;
}

export type OrderStatus = "awaiting_payment" | "paid" | "ready" | "picked_up" | "expired" | "replaced" | "canceled";

export interface OrderRecord {
  id: string;
  phone: string;
  orderNumber: number;
  squareOrderId: string;
  paymentLinkId: string;
  paymentLinkUrl: string;
  totalCents: number;
  currency: string;
  summary: string;
  status: OrderStatus;
  createdAt: Date;
  paidAt: Date | null;
  readyAt: Date | null;
}

export interface Store {
  getConversation(phone: string): Promise<Conversation>;
  saveConversation(c: Conversation): Promise<void>;
  listConversations(limit: number): Promise<Conversation[]>;

  createOrder(o: OrderRecord): Promise<void>;
  updateOrder(id: string, patch: Partial<OrderRecord>): Promise<void>;
  /** Applies the patch only if the order is currently in one of `from`. Returns the updated order, or null if it wasn't. */
  transitionOrder(id: string, from: OrderStatus[], patch: Partial<OrderRecord>): Promise<OrderRecord | null>;
  getOrderBySquareId(squareOrderId: string): Promise<OrderRecord | null>;
  getAwaitingOrderForPhone(phone: string): Promise<OrderRecord | null>;
  listAwaitingCreatedBefore(before: Date): Promise<OrderRecord[]>;
  listOrders(limit: number): Promise<OrderRecord[]>;
  countActiveOrders(): Promise<number>; // paid, not yet ready/picked up
  nextOrderNumber(): Promise<number>;

  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): Promise<void>;

  /** Returns true the first time an id is seen, false for duplicates (webhook retries). */
  claimEvent(id: string): Promise<boolean>;
  /** Undo a claim so a webhook retry gets processed again. */
  releaseEvent(id: string): Promise<void>;
}

export function newConversation(phone: string): Conversation {
  return {
    phone,
    customerName: null,
    messages: [],
    cart: [],
    pickupNote: null,
    humanUntil: null,
    optedOut: false,
    updatedAt: new Date(),
  };
}
