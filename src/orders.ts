import { randomUUID } from "node:crypto";
import type { SquareApi, SquareOrder, SquareOrderInput } from "./square/client.js";
import { formatMoney, variationAvailable, type Menu, type MenuService } from "./square/menu.js";
import type { CartLine, Conversation, OrderRecord, Store } from "./store/types.js";

export const MAX_QTY_PER_LINE = 25;

export interface CartProblem {
  line: number; // 1-based, 0 = whole cart
  message: string;
}

/** Checks a cart against the live menu and stock. Every problem is phrased so the AI can explain it to a customer. */
export function validateCart(menu: Menu, stock: Map<string, number>, cart: CartLine[]): CartProblem[] {
  const problems: CartProblem[] = [];
  if (cart.length === 0) problems.push({ line: 0, message: "The cart is empty." });
  const wanted = new Map<string, number>();

  cart.forEach((line, i) => {
    const n = i + 1;
    const hit = menu.byVariation.get(line.variationId);
    if (!hit) {
      problems.push({ line: n, message: `Line ${n}: unknown item id ${line.variationId}. Use an id from the menu.` });
      return;
    }
    const { item, variation } = hit;
    const label = item.variations.length > 1 ? `${item.name} (${variation.name})` : item.name;
    if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > MAX_QTY_PER_LINE) {
      problems.push({ line: n, message: `Line ${n}: quantity for ${label} must be 1-${MAX_QTY_PER_LINE}.` });
    }
    if (variation.priceCents == null) {
      problems.push({ line: n, message: `Line ${n}: ${label} has a variable price and can't be ordered by text.` });
    } else if (!variationAvailable(variation, stock)) {
      problems.push({ line: n, message: `Line ${n}: ${label} is sold out.` });
    }
    if (variation.trackInventory) wanted.set(variation.id, (wanted.get(variation.id) ?? 0) + (line.quantity || 0));

    const counts = new Map<string, number>();
    for (const modId of line.modifierIds) {
      const list = item.modifierLists.find((ml) => ml.modifiers.some((m) => m.id === modId));
      if (!list) {
        problems.push({ line: n, message: `Line ${n}: option id ${modId} isn't available on ${label}.` });
        continue;
      }
      const mod = list.modifiers.find((m) => m.id === modId)!;
      if (mod.soldOut) problems.push({ line: n, message: `Line ${n}: "${mod.name}" is sold out.` });
      counts.set(list.id, (counts.get(list.id) ?? 0) + 1);
    }
    for (const ml of item.modifierLists) {
      const c = counts.get(ml.id) ?? 0;
      if (c < ml.min) problems.push({ line: n, message: `Line ${n}: ${label} needs a choice for "${ml.name}" (pick ${ml.min}).` });
      if (ml.max != null && c > ml.max) problems.push({ line: n, message: `Line ${n}: ${label} allows at most ${ml.max} for "${ml.name}".` });
    }
  });

  for (const [variationId, qty] of wanted) {
    const have = stock.get(variationId) ?? 0;
    if (qty > have && have > 0) {
      const { item } = menu.byVariation.get(variationId)!;
      problems.push({ line: 0, message: `Only ${have} ${item.name} left; the cart has ${qty}.` });
    }
  }
  return problems;
}

export function buildSquareOrder(opts: {
  locationId: string;
  cart: CartLine[];
  conv: Conversation;
  orderNumber?: number;
  pickupPrepMinutes?: number;
}): SquareOrderInput {
  const { cart, conv } = opts;
  return {
    location_id: opts.locationId,
    ...(opts.orderNumber ? { reference_id: `TEXT-${opts.orderNumber}` } : {}),
    line_items: cart.map((l) => ({
      catalog_object_id: l.variationId,
      quantity: String(l.quantity),
      ...(l.modifierIds.length ? { modifiers: l.modifierIds.map((id) => ({ catalog_object_id: id })) } : {}),
      ...(l.note ? { note: l.note.slice(0, 200) } : {}),
    })),
    fulfillments: [
      {
        type: "PICKUP",
        state: "PROPOSED",
        pickup_details: {
          recipient: { display_name: conv.customerName || `Text order${opts.orderNumber ? ` #${opts.orderNumber}` : ""}`, phone_number: conv.phone },
          schedule_type: "ASAP",
          ...(opts.pickupPrepMinutes ? { prep_time_duration: `PT${opts.pickupPrepMinutes}M` } : {}),
          note: [opts.orderNumber ? `Text order #${opts.orderNumber}` : "Text order", conv.pickupNote].filter(Boolean).join(" · ").slice(0, 500),
        },
      },
    ],
    metadata: { source: "text-to-order" },
    ...(conv.squareCustomerId ? { customer_id: conv.squareCustomerId } : {}),
  };
}

export interface Quote {
  currency: string;
  totalCents: number;
  taxCents: number;
  discountCents: number;
  text: string; // deterministic, customer-facing summary
}

/** Builds the order summary from Square's own calculated numbers, never from the AI. */
export function quoteFromOrder(order: SquareOrder): Quote {
  const currency = order.total_money?.currency ?? "CAD";
  const lines: string[] = [];
  for (const li of order.line_items ?? []) {
    const variation = li.variation_name && li.variation_name !== "Regular" ? ` (${li.variation_name})` : "";
    const amount = li.gross_sales_money?.amount ?? li.total_money?.amount ?? 0;
    lines.push(`${li.quantity} × ${li.name ?? "Item"}${variation} · ${formatMoney(amount, currency)}`);
    for (const m of li.modifiers ?? []) lines.push(`   + ${m.name}`);
  }
  const discount = order.total_discount_money?.amount ?? 0;
  const tax = order.total_tax_money?.amount ?? 0;
  const total = order.total_money?.amount ?? 0;
  if (discount) lines.push(`Discount · -${formatMoney(discount, currency)}`);
  lines.push(`Tax · ${formatMoney(tax, currency)}`);
  lines.push(`Total ${formatMoney(total, currency)}`);
  return { currency, totalCents: total, taxCents: tax, discountCents: discount, text: lines.join("\n") };
}

export interface OrderServiceDeps {
  square: SquareApi;
  menus: MenuService;
  store: Store;
  locationId: string;
  maxActiveOrders: number;
  allowTipping?: boolean;
  isAcceptingOrders: () => Promise<{ ok: true } | { ok: false; reason: string }>;
  now?: () => Date;
}

export type CheckoutResult =
  | { ok: true; order: OrderRecord; quote: Quote }
  | { ok: false; reason: string };

export class OrderService {
  constructor(private d: OrderServiceDeps) {}

  /** Validates and prices a cart. Used when the AI sets the cart so it can tell the customer about problems early. */
  async quote(conv: Conversation): Promise<{ ok: true; quote: Quote } | { ok: false; problems: string[] }> {
    const menu = await this.d.menus.getMenu();
    const stock = await this.d.menus.getStock(menu, conv.cart.map((l) => l.variationId));
    const problems = validateCart(menu, stock, conv.cart);
    if (problems.length) return { ok: false, problems: problems.map((p) => p.message) };
    const calc = await this.d.square.calculateOrder(buildSquareOrder({ locationId: this.d.locationId, cart: conv.cart, conv }));
    return { ok: true, quote: quoteFromOrder(calc) };
  }

  /** Re-checks everything, retires any earlier unpaid link, and creates a fresh Square payment link. */
  async checkout(conv: Conversation): Promise<CheckoutResult> {
    const gate = await this.d.isAcceptingOrders();
    if (!gate.ok) return gate;
    if ((await this.d.store.countActiveOrders()) >= this.d.maxActiveOrders) {
      return { ok: false, reason: "The kitchen is at its limit for text orders right now. Try again in a few minutes, or order at the window." };
    }

    const menu = await this.d.menus.getMenu(true); // fresh catalog: sold-out flags may have changed
    const stock = await this.d.menus.getStock(menu, conv.cart.map((l) => l.variationId));
    const problems = validateCart(menu, stock, conv.cart);
    if (problems.length) return { ok: false, reason: problems.map((p) => p.message).join(" ") };

    await this.retireAwaiting(conv.phone, "replaced");

    const orderNumber = await this.d.store.nextOrderNumber();
    const orderInput = buildSquareOrder({ locationId: this.d.locationId, cart: conv.cart, conv, orderNumber });
    const { link, order } = await this.d.square.createPaymentLink({
      idempotencyKey: randomUUID(),
      order: orderInput,
      buyerPhone: conv.phone,
      allowTipping: this.d.allowTipping,
    });
    try {
      const priced = order?.total_money ? order : await this.d.square.retrieveOrder(link.order_id);
      const quote = quoteFromOrder(priced);

    const record: OrderRecord = {
      id: randomUUID(),
      phone: conv.phone,
      orderNumber,
      squareOrderId: link.order_id,
      paymentLinkId: link.id,
      paymentLinkUrl: link.url,
      checkoutKind: "link",
      invoiceId: null,
      invoiceVersion: null,
      squarePaymentId: null,
      customerId: conv.squareCustomerId,
      cart: conv.cart,
      pickupAt: null,
      pickupSlot: "asap",
      quotedReadyAt: null,
      etaNotifiedAt: null,
      totalCents: quote.totalCents,
      currency: quote.currency,
      summary: quote.text,
      status: "awaiting_payment",
      createdAt: (this.d.now ?? (() => new Date()))(),
      paidAt: null,
      readyAt: null,
    };
      await this.d.store.createOrder(record);
      return { ok: true, order: record, quote };
    } catch (err) {
      // Never leave a payable link that we have no record of.
      await this.d.square.deletePaymentLink(link.id).catch(() => {});
      throw err;
    }
  }

  /** Deletes the unpaid payment link (if any) so a stale total can't be paid. */
  async retireAwaiting(phone: string, status: "replaced" | "expired" | "canceled"): Promise<OrderRecord | null> {
    const existing = await this.d.store.getAwaitingOrderForPhone(phone);
    if (!existing) return null;
    return this.retire(existing, status);
  }

  /** Deletes the link first, then marks the order, only if it's still unpaid (a payment may land at the same moment). */
  async retire(order: OrderRecord, status: "replaced" | "expired" | "canceled"): Promise<OrderRecord | null> {
    if (order.paymentLinkId) await this.d.square.deletePaymentLink(order.paymentLinkId);
    return this.d.store.transitionOrder(order.id, ["awaiting_payment"], { status });
  }
}
