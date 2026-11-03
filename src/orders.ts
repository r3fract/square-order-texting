import { createHash, randomUUID } from "node:crypto";
import { SquareError, type SquareApi, type SquareOrder, type SquareOrderInput } from "./square/client.js";
import { formatMoney, variationAvailable, type Menu, type MenuService } from "./square/menu.js";
import type { ResolvedPickup } from "./pickup.js";
import type { CartLine, Conversation, OrderRecord, SavedCard, Store } from "./store/types.js";

export const MAX_QTY_PER_LINE = 25;
const ONE_TAP_WINDOW_MS = 10 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
/** The only replies that count as "yes, charge my card". Checked in code, not left to the AI. */
const AFFIRMATIVE = /^\s*(y|yes|yep|yup|yeah)\s*[.!]*\s*$/i;
/** A reply that picks a card from the numbered list. */
const CARD_NUMBER = /^\s*#?([1-9])\s*[.!]*\s*$/;
/** Square error codes that mean the card was declined (safe to offer a link instead). Anything else: outcome unknown. */
const DECLINE_CODES = new Set([
  "CARD_DECLINED", "GENERIC_DECLINE", "INSUFFICIENT_FUNDS", "CVV_FAILURE", "ADDRESS_VERIFICATION_FAILURE", "CARD_EXPIRED",
  "INVALID_EXPIRATION", "BAD_EXPIRATION", "CARD_NOT_SUPPORTED", "INVALID_CARD", "INVALID_ACCOUNT", "PAN_FAILURE",
  "TRANSACTION_LIMIT", "CARD_DECLINED_CALL_ISSUER", "CARD_DECLINED_VERIFICATION_REQUIRED", "VOICE_FAILURE",
  "ALLOWABLE_PIN_TRIES_EXCEEDED", "EXPIRATION_FAILURE", "INVALID_PIN", "CHIP_INSERTION_REQUIRED",
]);

/** What the customer actually sent this turn, so consent is checked in code. */
export interface Consent {
  text: string;
  /** Id of the inbound text being handled (Twilio message SID). */
  turnId: string;
  /** Arrival order of that text (assigned before it waits for the per-phone lock). */
  seq: number;
}

/** Stable fingerprint of a cart, so a one-word "Y" only pays for exactly what was read back. */
export function cartHash(cart: CartLine[]): string {
  const norm = cart
    .map((l) => ({ v: l.variationId, q: l.quantity, m: [...l.modifierIds].sort(), n: l.note ?? "" }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return createHash("sha256").update(JSON.stringify(norm)).digest("hex");
}

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
  /** Set for scheduled pickups (intermission, after the game, clock time). */
  pickupAt?: Date | null;
  pickupLabel?: string;
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
          ...(opts.pickupAt
            ? { schedule_type: "SCHEDULED", pickup_at: opts.pickupAt.toISOString() }
            : { schedule_type: "ASAP" }),
          ...(opts.pickupPrepMinutes ? { prep_time_duration: `PT${opts.pickupPrepMinutes}M` } : {}),
          note: [opts.orderNumber ? `Text order #${opts.orderNumber}` : "Text order", opts.pickupAt ? opts.pickupLabel : null, conv.pickupNote]
            .filter(Boolean)
            .join(" · ")
            .slice(0, 500),
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
  intermissionCapacity: number;
  prepMinutes: number;
  /** Resolves the conversation's pickup target against the live game clock. */
  pickup: (conv: Conversation) => ResolvedPickup;
  allowTipping?: boolean;
  oneTapMaxCents: number;
  oneTapDailyMaxCents: number;
  /** Re-reads the customer's Square profile and saved card right before a charge. */
  refreshCustomer: (conv: Conversation) => Promise<void>;
  timeZone: string;
  /** Finds or creates the Square customer profile for this phone (invoices need one). */
  ensureCustomer: (conv: Conversation) => Promise<string>;
  isAcceptingOrders: () => Promise<{ ok: true } | { ok: false; reason: string }>;
  now?: () => Date;
}

export type CheckoutResult =
  | { ok: true; order: OrderRecord; quote: Quote }
  | { ok: false; reason: string };

export type CardPayResult =
  | { ok: true; order: OrderRecord; quote: Quote; card: SavedCard }
  | { ok: false; reason: string }
  | { ok: false; reason: string; fallbackToLink: true };

/** "1 or 2", "1, 2 or 3" */
export function numberChoices(n: number): string {
  const nums = Array.from({ length: n }, (_, i) => String(i + 1));
  return nums.length === 1 ? "1" : `${nums.slice(0, -1).join(", ")} or ${nums.at(-1)}`;
}

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
    if (await this.unconfirmedCardOrder(conv.phone)) return { ok: false, reason: OrderService.STILL_CONFIRMING };
    const pickup = this.d.pickup(conv);
    if (!pickup.ok) return { ok: false, reason: pickup.reason };
    const full = await this.slotFull(pickup);
    if (full) return { ok: false, reason: full };

    const menu = await this.d.menus.getMenu(true); // fresh catalog: sold-out flags may have changed
    const stock = await this.d.menus.getStock(menu, conv.cart.map((l) => l.variationId));
    const problems = validateCart(menu, stock, conv.cart);
    if (problems.length) return { ok: false, reason: problems.map((p) => p.message).join(" ") };

    await this.retireAwaiting(conv.phone, "replaced");

    const orderNumber = await this.d.store.nextOrderNumber();
    const orderInput = buildSquareOrder({
      locationId: this.d.locationId,
      cart: conv.cart,
      conv,
      orderNumber,
      pickupAt: pickup.pickupAt,
      pickupLabel: pickup.label,
      ...(pickup.pickupAt ? { pickupPrepMinutes: this.d.prepMinutes } : {}),
    });
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
      loyaltyRewardId: null,
      invoiceId: null,
      invoiceVersion: null,
      squarePaymentId: null,
      customerId: conv.squareCustomerId,
      cart: conv.cart,
      pickupAt: pickup.pickupAt,
      pickupSlot: pickup.slotKey,
      quotedReadyAt: pickup.pickupAt,
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
      conv.pendingOneTap = null; // a link went out: a later "Y" must not also charge the card
      return { ok: true, order: record, quote };
    } catch (err) {
      // Never leave a payable link that we have no record of.
      await this.d.square.deletePaymentLink(link.id).catch(() => {});
      throw err;
    }
  }

  private nowDate() {
    return (this.d.now ?? (() => new Date()))();
  }

  /** Card-on-file charges for this phone in the last 24 hours, counting ones Square hasn't confirmed yet. */
  private async spentToday(phone: string): Promise<number> {
    const since = new Date(this.nowDate().getTime() - DAY_MS);
    return (await this.d.store.listCardOrdersSince(phone, since))
      .filter((o) => ["paid", "ready", "picked_up", "awaiting_payment"].includes(o.status))
      .reduce((s, o) => s + o.totalCents, 0);
  }

  /** A card charge for this phone whose outcome Square hasn't confirmed (e.g. a timeout). */
  async unconfirmedCardOrder(phone: string): Promise<OrderRecord | null> {
    const since = new Date(this.nowDate().getTime() - DAY_MS);
    return (await this.d.store.listCardOrdersSince(phone, since)).find((o) => o.status === "awaiting_payment") ?? null;
  }

  private static readonly STILL_CONFIRMING =
    "We're still confirming your last card payment with Square. Tell them not to pay again yet: they'll get a text as soon as it's sorted.";

  /** One-word pay is only for a single, unambiguous Square customer with a saved card, under the per-order and daily caps. */
  async oneTapEligible(conv: Conversation, totalCents: number): Promise<boolean> {
    if (!(conv.savedCard && conv.squareCustomerId && !conv.customerAmbiguous && totalCents > 0 && totalCents <= this.d.oneTapMaxCents)) return false;
    if (await this.unconfirmedCardOrder(conv.phone)) return false;
    return (await this.spentToday(conv.phone)) + totalCents <= this.d.oneTapDailyMaxCents;
  }

  /** After a successful quote: open (or clear) the one-word pay offer for exactly this cart and total. */
  async offerOneTap(conv: Conversation, totalCents: number, turnId?: string): Promise<boolean> {
    if (!(await this.oneTapEligible(conv, totalCents))) {
      conv.pendingOneTap = null;
      return false;
    }
    const cardIds = (conv.savedCards?.length ? conv.savedCards : [conv.savedCard!]).map((c) => c.id);
    conv.pendingOneTap = { cartHash: cartHash(conv.cart), totalCents, offeredAt: this.nowDate(), cardIds, ...(turnId ? { turnId } : {}) };
    return true;
  }

  /**
   * Charges the saved card for the cart the customer just said "Y" to. Refuses (never charges) unless the offer is
   * open, under 10 minutes old, for this exact cart, and Square's order total still matches what was offered.
   */
  async payWithSavedCard(conv: Conversation, consent: Consent): Promise<CardPayResult> {
    const now = this.nowDate();
    if (await this.unconfirmedCardOrder(conv.phone)) return { ok: false, reason: OrderService.STILL_CONFIRMING };
    const p = conv.pendingOneTap;
    // Consent: a plain yes (one card) or a number from the list, in a text that arrived after the offer was sent.
    let chosenId: string | undefined;
    if (p) {
      const listed = p.cardIds?.length ? p.cardIds : conv.savedCard ? [conv.savedCard.id] : [];
      const num = consent.text.match(CARD_NUMBER)?.[1];
      const fresh = p.turnId !== consent.turnId && p.shownAfterSeq != null && consent.seq > p.shownAfterSeq;
      if (!fresh || (!num && !AFFIRMATIVE.test(consent.text))) {
        return { ok: false, reason: "Wait for them to reply Y (or a card number) to your offer before calling pay_with_saved_card." };
      }
      if (num) {
        chosenId = listed[Number(num) - 1];
        if (!chosenId) return { ok: false, reason: `That number isn't on the list. Ask them to reply ${numberChoices(listed.length)}.` };
      } else if (listed.length > 1) {
        return { ok: false, reason: `Ask which card: reply ${numberChoices(listed.length)}.` };
      } else {
        chosenId = listed[0];
      }
    }
    if (!p) {
      const recent = (await this.d.store.listOrders(50)).find(
        (o) => o.phone === conv.phone && o.checkoutKind === "card_on_file" && o.squarePaymentId && now.getTime() - o.createdAt.getTime() < ONE_TAP_WINDOW_MS,
      );
      return { ok: false, reason: recent ? "That order is already paid." : "There's no one-word pay offer open. Read the order back first." };
    }
    if (p.cartHash !== cartHash(conv.cart)) {
      await this.releaseReward(p.rewardId);
      conv.pendingOneTap = null;
      return { ok: false, reason: "The order changed since the offer. Call set_cart, read it back and offer again." };
    }
    if (now.getTime() - new Date(p.offeredAt).getTime() > ONE_TAP_WINDOW_MS) {
      await this.releaseReward(p.rewardId);
      conv.pendingOneTap = null;
      return { ok: false, reason: "That offer expired. Call set_cart, read the order back and offer again." };
    }
    await this.d.refreshCustomer(conv); // the card or profile may have changed in Square since the offer
    const current = conv.savedCards?.length ? conv.savedCards : conv.savedCard ? [conv.savedCard] : [];
    const listed = p.cardIds?.length ? p.cardIds : chosenId ? [chosenId] : [];
    if (current.length && listed.some((id) => !current.some((c) => c.id === id))) {
      // The numbered list the customer answered no longer matches their cards: a number could now mean a different
      // card. Re-offer the current list (code shows it) instead of charging.
      conv.pendingOneTap = { ...p, cardIds: current.map((c) => c.id), offeredAt: now, turnId: consent.turnId, shownAfterSeq: undefined };
      return { ok: false, reason: "Their saved cards changed since the offer, so nothing was charged. The updated list is added to your reply; ask them to pick again." };
    }
    const card = current.find((c) => c.id === chosenId);
    if (!card) {
      conv.pendingOneTap = null;
      return { ok: false, reason: "The saved card isn't available anymore. Send the payment link instead." };
    }
    if (!(await this.oneTapEligible(conv, p.totalCents))) {
      conv.pendingOneTap = null;
      return { ok: false, reason: "One-word pay isn't available for this order. Send the payment link instead." };
    }

    const gate = await this.d.isAcceptingOrders();
    if (!gate.ok) return gate;
    const pickup = this.d.pickup(conv);
    if (!pickup.ok) return { ok: false, reason: pickup.reason };
    const full = await this.slotFull(pickup);
    if (full) return { ok: false, reason: full };
    const menu = await this.d.menus.getMenu(true);
    const stock = await this.d.menus.getStock(menu, conv.cart.map((l) => l.variationId));
    const problems = validateCart(menu, stock, conv.cart);
    if (problems.length) return { ok: false, reason: problems.map((x) => x.message).join(" ") };

    // An open link or invoice may already be paid on Square's page with its webhook still on the way.
    const open = await this.d.store.getAwaitingOrderForPhone(conv.phone);
    if (open && open.checkoutKind !== "card_on_file") {
      if ((await this.cardChargeOutcome(open)) !== "unpaid") {
        conv.pendingOneTap = null;
        return { ok: false, reason: `Order #${open.orderNumber} looks already paid (or Square can't tell yet), so the card wasn't charged. It'll show as paid shortly.` };
      }
      await this.retire(open, "replaced");
    }

    // A re-offer (total changed) already made the Square order: reuse it so a reward isn't attached twice.
    const recordId = p.recordId ?? randomUUID();
    const orderNumber = p.orderNumber ?? (await this.d.store.nextOrderNumber());
    let rewardId = p.rewardId;
    const sqOrder = p.squareOrderId
      ? await this.d.square.retrieveOrder(p.squareOrderId)
      : await this.withReward(
          conv,
          await this.d.square.createOrder({
            idempotencyKey: `order:${recordId}`,
            order: buildSquareOrder({
              locationId: this.d.locationId,
              cart: conv.cart,
              conv,
              orderNumber,
              pickupAt: pickup.pickupAt,
              pickupLabel: pickup.label,
              ...(pickup.pickupAt ? { pickupPrepMinutes: this.d.prepMinutes } : {}),
            }),
          }),
          recordId,
          (id) => (rewardId = id),
        );
    const quote = quoteFromOrder(sqOrder);
    if (quote.totalCents !== p.totalCents) {
      conv.pendingOneTap = {
        cartHash: p.cartHash,
        totalCents: quote.totalCents,
        offeredAt: now,
        turnId: consent.turnId,
        squareOrderId: sqOrder.id!,
        recordId,
        orderNumber,
        cardIds: current.map((c) => c.id), // the list as it is now (just re-read from Square)
        ...(rewardId ? { rewardId } : {}),
      };
      return { ok: false, reason: `The total is now ${formatMoney(quote.totalCents, quote.currency)}. Read that out and ask them to reply Y again to pay it.` };
    }

    const record: OrderRecord = {
      id: recordId,
      phone: conv.phone,
      orderNumber,
      squareOrderId: sqOrder.id!,
      paymentLinkId: null,
      paymentLinkUrl: null,
      checkoutKind: "card_on_file",
      loyaltyRewardId: rewardId ?? null,
      invoiceId: null,
      invoiceVersion: null,
      squarePaymentId: null,
      customerId: conv.squareCustomerId,
      cart: conv.cart,
      pickupAt: pickup.pickupAt,
      pickupSlot: pickup.slotKey,
      quotedReadyAt: pickup.pickupAt,
      etaNotifiedAt: null,
      totalCents: quote.totalCents,
      currency: quote.currency,
      summary: quote.text,
      status: "awaiting_payment",
      createdAt: now,
      paidAt: null,
      readyAt: null,
    };
    await this.d.store.createOrder(record); // before charging, so Square's webhook can find it

    let payment;
    let unclear = false;
    try {
      payment = await this.d.square.createPayment({
        idempotencyKey: `card:${recordId}`,
        sourceId: card.id,
        customerId: conv.squareCustomerId!,
        orderId: sqOrder.id!,
        amount: { amount: quote.totalCents, currency: quote.currency },
        locationId: this.d.locationId,
      });
    } catch (err) {
      payment = null;
      // A clear decline is safe to fall back from. Anything else (timeouts, 5xx) may still have charged the card.
      const codes = err instanceof SquareError ? err.errors.map((e) => e.code ?? "") : [];
      unclear = !codes.some((c) => DECLINE_CODES.has(c));
    }
    conv.pendingOneTap = null;
    if (unclear || (payment && payment.status !== "COMPLETED" && payment.status !== "FAILED")) {
      // Leave the record awaiting payment: Square's webhook marks it paid if the charge went through.
      return {
        ok: false,
        reason: "We couldn't confirm that payment with Square yet. Tell them not to pay again: they'll get a text as soon as it goes through.",
      };
    }
    if (!payment || payment.status !== "COMPLETED") {
      await this.d.store.transitionOrder(record.id, ["awaiting_payment"], { status: "canceled" });
      await this.releaseReward(rewardId); // the fallback link is full price: give their points back
      conv.pendingRewardTierId = null;
      return { ok: false, reason: "The saved card was declined.", fallbackToLink: true };
    }
    await this.d.store.updateOrder(record.id, { squarePaymentId: payment.id });
    record.squarePaymentId = payment.id;
    conv.pendingRewardTierId = null;
    return { ok: true, order: record, quote, card };
  }

  /** Null if the pickup slot has room, else the reason to tell the customer. */
  async slotFull(p: Extract<ResolvedPickup, { ok: true }>): Promise<string | null> {
    if (p.slotKey.startsWith("game:")) {
      if ((await this.d.store.countOrdersInSlot(p.slotKey)) >= this.d.intermissionCapacity) {
        return `${p.label[0]!.toUpperCase()}${p.label.slice(1)} is full. Want the next one, or right away?`;
      }
      return null;
    }
    if (p.slotKey.startsWith("clock:")) {
      if ((await this.d.store.countOrdersInSlot(p.slotKey)) >= this.d.maxActiveOrders) {
        return `${p.label[0]!.toUpperCase()}${p.label.slice(1)} is full. Want a different time, or right away?`;
      }
      return null;
    }
    // Orders scheduled for later intermissions don't count against the kitchen's right-now limit.
    if ((await this.d.store.countActiveAsapOrders((this.d.now ?? (() => new Date()))())) >= this.d.maxActiveOrders) {
      return "The kitchen is at its limit for text orders right now. Try again in a few minutes, or order at the window.";
    }
    return null;
  }

  /** If the customer asked to redeem a loyalty reward, attach it so Square applies the discount; returns the re-read order. */
  private async withReward(conv: Conversation, order: SquareOrder, recordId: string, onReward: (id: string) => void = () => {}): Promise<SquareOrder> {
    if (!conv.pendingRewardTierId || !conv.loyaltyAccountId || !order.id) return order;
    const reward = await this.d.square.createLoyaltyReward({
      accountId: conv.loyaltyAccountId,
      rewardTierId: conv.pendingRewardTierId,
      orderId: order.id,
      idempotencyKey: `reward:${recordId}`,
    });
    onReward(reward.id);
    return this.d.square.retrieveOrder(order.id);
  }

  /** Releases a reward from an order that won't be paid, so the customer keeps their points. Best effort. */
  private async releaseReward(rewardId: string | null | undefined) {
    if (rewardId) await this.d.square.deleteLoyaltyReward(rewardId).catch(() => {});
  }

  /** Offer the save-my-card page once, to customers Square knows who have no saved card yet. */
  shouldOfferCardSave(conv: Conversation): boolean {
    return !!(conv.squareCustomerId && !conv.savedCard && !conv.customerAmbiguous && !conv.cardOfferMadeAt);
  }

  /**
   * Checkout through a Square invoice with "Save my card on file" turned on: same rules as a payment link, but the
   * customer can save their card on Square's own page for one-word ordering next time.
   */
  async checkoutWithInvoice(conv: Conversation): Promise<CheckoutResult> {
    const gate = await this.d.isAcceptingOrders();
    if (!gate.ok) return gate;
    if (await this.unconfirmedCardOrder(conv.phone)) return { ok: false, reason: OrderService.STILL_CONFIRMING };
    const pickup = this.d.pickup(conv);
    if (!pickup.ok) return { ok: false, reason: pickup.reason };
    const full = await this.slotFull(pickup);
    if (full) return { ok: false, reason: full };
    const menu = await this.d.menus.getMenu(true);
    const stock = await this.d.menus.getStock(menu, conv.cart.map((l) => l.variationId));
    const problems = validateCart(menu, stock, conv.cart);
    if (problems.length) return { ok: false, reason: problems.map((p) => p.message).join(" ") };

    const customerId = await this.d.ensureCustomer(conv);
    await this.retireAwaiting(conv.phone, "replaced");

    const recordId = randomUUID();
    const orderNumber = await this.d.store.nextOrderNumber();
    let invoiceRewardId: string | null = null;
    const sqOrder = await this.withReward(
      conv,
      await this.d.square.createOrder({
        idempotencyKey: `order:${recordId}`,
        order: buildSquareOrder({
          locationId: this.d.locationId,
          cart: conv.cart,
          conv,
          orderNumber,
          pickupAt: pickup.pickupAt,
          pickupLabel: pickup.label,
          ...(pickup.pickupAt ? { pickupPrepMinutes: this.d.prepMinutes } : {}),
        }),
      }),
      recordId,
      (id) => (invoiceRewardId = id),
    );
    conv.pendingRewardTierId = null;
    const quote = quoteFromOrder(sqOrder);
    const dueDate = this.nowDate().toLocaleDateString("en-CA", { timeZone: this.d.timeZone });
    const draft = await this.d.square.createInvoice({ idempotencyKey: `invoice:${recordId}`, orderId: sqOrder.id!, customerId, locationId: this.d.locationId, dueDate });
    const inv = await this.d.square.publishInvoice(draft.id, draft.version, `publish:${recordId}`);
    try {
      const record: OrderRecord = {
        id: recordId,
        phone: conv.phone,
        orderNumber,
        squareOrderId: sqOrder.id!,
        paymentLinkId: null,
        paymentLinkUrl: inv.public_url ?? null,
        checkoutKind: "invoice",
        loyaltyRewardId: invoiceRewardId,
        invoiceId: inv.id,
        invoiceVersion: inv.version,
        squarePaymentId: null,
        customerId,
        cart: conv.cart,
        pickupAt: pickup.pickupAt,
        pickupSlot: pickup.slotKey,
        quotedReadyAt: pickup.pickupAt,
        etaNotifiedAt: null,
        totalCents: quote.totalCents,
        currency: quote.currency,
        summary: quote.text,
        status: "awaiting_payment",
        createdAt: this.nowDate(),
        paidAt: null,
        readyAt: null,
      };
      await this.d.store.createOrder(record);
      conv.pendingOneTap = null; // a page went out: a later "Y" must not also charge the card
      return { ok: true, order: record, quote };
    } catch (err) {
      await this.d.square.cancelInvoice(inv.id, inv.version).catch(() => {}); // never leave a payable page we have no record of
      throw err;
    }
  }

  /** Deletes the unpaid payment link (if any) so a stale total can't be paid. */
  async retireAwaiting(phone: string, status: "replaced" | "expired" | "canceled"): Promise<OrderRecord | null> {
    const existing = await this.d.store.getAwaitingOrderForPhone(phone);
    if (!existing) return null;
    if (existing.checkoutKind === "card_on_file") return null; // an unconfirmed charge is settled with Square, never replaced
    return this.retire(existing, status);
  }

  /**
   * For a card charge whose outcome was unclear: ask Square. "paid" if the order has a tender, "unpaid" if Square
   * shows none, "unknown" if Square can't be reached (try again later).
   */
  async cardChargeOutcome(order: OrderRecord): Promise<"paid" | "unpaid" | "unknown"> {
    try {
      const sq = await this.d.square.retrieveOrder(order.squareOrderId);
      return sq.state === "COMPLETED" || (sq.tenders?.length ?? 0) > 0 ? "paid" : "unpaid";
    } catch {
      return "unknown";
    }
  }

  /** Deletes the link first, then marks the order, only if it's still unpaid (a payment may land at the same moment). */
  async retire(order: OrderRecord, status: "replaced" | "expired" | "canceled"): Promise<OrderRecord | null> {
    if (order.checkoutKind === "invoice" && order.invoiceId) {
      await this.d.square.cancelInvoice(order.invoiceId, order.invoiceVersion ?? 0);
      await this.releaseReward(order.loyaltyRewardId);
    }
    else if (order.checkoutKind === "link" && order.paymentLinkId) await this.d.square.deletePaymentLink(order.paymentLinkId);
    // card_on_file: nothing payable to take down
    return this.d.store.transitionOrder(order.id, ["awaiting_payment"], { status });
  }
}
