export interface CartLine {
  variationId: string;
  quantity: number;
  modifierIds: string[];
  note?: string;
}

export type PickupTarget =
  | { kind: "asap" }
  | { kind: "intermission"; n: 1 | 2 }
  | { kind: "next_intermission" }
  | { kind: "after_game" }
  | { kind: "clock"; hhmm: string };

export interface SavedCard {
  id: string;
  brand: string;
  last4: string;
}

export interface PendingOneTap {
  cartHash: string;
  totalCents: number;
  offeredAt: Date;
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
  squareCustomerId: string | null;
  customerAmbiguous: boolean; // phone matches several Square profiles: no card features
  customerLookupAt: Date | null;
  savedCard: SavedCard | null;
  pendingOneTap: PendingOneTap | null;
  cardOfferMadeAt: Date | null;
  pickupTarget: PickupTarget | null;
  loyaltyAccountId: string | null;
}

export type OrderStatus = "awaiting_payment" | "paid" | "ready" | "picked_up" | "expired" | "replaced" | "canceled";

export interface OrderRecord {
  id: string;
  phone: string;
  orderNumber: number;
  squareOrderId: string;
  paymentLinkId: string | null;
  paymentLinkUrl: string | null; // for invoices: the Square invoice page
  checkoutKind: "link" | "invoice" | "card_on_file";
  invoiceId: string | null;
  invoiceVersion: number | null;
  squarePaymentId: string | null;
  customerId: string | null;
  cart: CartLine[];
  pickupAt: Date | null;
  pickupSlot: string | null; // "asap", "clock", "game:<id>:int1|int2|end"
  quotedReadyAt: Date | null;
  etaNotifiedAt: Date | null;
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
  countOrdersInSlot(slotKey: string): Promise<number>; // paid or awaiting payment
  listOrdersInSlotPrefix(prefix: string): Promise<OrderRecord[]>;
  lastPaidOrderForPhone(phone: string): Promise<OrderRecord | null>; // paid, ready or picked up; newest
  countActiveAsapOrders(now: Date): Promise<number>; // paid, due now (no pickup time, or pickup time already reached)
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
    squareCustomerId: null,
    customerAmbiguous: false,
    customerLookupAt: null,
    savedCard: null,
    pendingOneTap: null,
    cardOfferMadeAt: null,
    pickupTarget: null,
    loyaltyAccountId: null,
  };
}
