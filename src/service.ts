import { runAgentTurn, type AgentDeps, type ModelClient } from "./agent.js";
import type { Config } from "./config.js";
import { describeHours, isOpen, keyword, nextOpeningText, normalizePhone, redactCardNumbers } from "./guards.js";
import { HoursService } from "./hours.js";
import { OrderService } from "./orders.js";
import type { SquareApi } from "./square/client.js";
import { formatMoney, MenuService } from "./square/menu.js";
import type { SmsSender } from "./sms.js";
import type { Conversation, Store } from "./store/types.js";

const HISTORY_RESET_MS = 6 * 60 * 60 * 1000; // a new chat after 6 quiet hours
const HANDOFF_MS = 2 * 60 * 60 * 1000; // bot stays quiet for 2h after a handoff unless staff hand back
const MAX_SMS_CHARS = 1500;

export interface ServiceDeps {
  config: Config;
  store: Store;
  square: SquareApi;
  sms: SmsSender;
  model: ModelClient;
  now?: () => Date;
  log?: (msg: string, extra?: unknown) => void;
}

/** Everything the webhooks call into. No HTTP here, so it can be tested directly. */
export class TextOrderService {
  readonly menus: MenuService;
  readonly orders: OrderService;
  readonly hoursService: HoursService;
  private locks = new Map<string, Promise<unknown>>();
  private now: () => Date;
  private log: (msg: string, extra?: unknown) => void;

  constructor(private d: ServiceDeps) {
    this.now = d.now ?? (() => new Date());
    this.log = d.log ?? ((m, e) => console.log(m, e ?? ""));
    this.menus = new MenuService(d.square, d.config.SQUARE_LOCATION_ID);
    this.hoursService = new HoursService(d.square, d.config.hours);
    this.orders = new OrderService({
      square: d.square,
      menus: this.menus,
      store: d.store,
      locationId: d.config.SQUARE_LOCATION_ID,
      maxActiveOrders: d.config.MAX_ACTIVE_ORDERS,
      allowTipping: d.config.ALLOW_TIPPING,
      now: () => this.now(),
      isAcceptingOrders: async () => {
        const s = await this.orderingStatus();
        return s.open ? { ok: true as const } : { ok: false as const, reason: s.message };
      },
    });
  }

  /** Runs work for one phone number at a time so fast double-texts don't race each other. */
  private withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.locks.set(key, next);
    next.finally(() => {
      if (this.locks.get(key) === next) this.locks.delete(key);
    }).catch(() => {});
    return next;
  }

  async orderingStatus(): Promise<{ open: boolean; message: string }> {
    const { config } = this.d;
    if ((await this.d.store.getSetting("paused")) === "true") {
      return { open: false, message: "Text ordering is paused right now. Please order at the window." };
    }
    const hours = await this.hours();
    if (!hours) return { open: false, message: "Text ordering isn't open right now. Please order at the window." };
    if (!isOpen(hours, this.now(), config.TIMEZONE)) {
      return { open: false, message: `Text ordering is closed right now. ${nextOpeningText(hours, this.now(), config.TIMEZONE)}`.trim() };
    }
    return { open: true, message: "Text ordering is open." };
  }

  /** Ordering hours right now: the ORDERING_HOURS override, else Square business hours. */
  hours() {
    return this.hoursService.current();
  }

  private async save(conv: Conversation) {
    conv.updatedAt = this.now();
    await this.d.store.saveConversation(conv);
  }

  /** Texts never throw: a failed text must not undo a payment or block a webhook. Failures are logged. */
  private async send(to: string, body: string): Promise<boolean> {
    const text = body.length > MAX_SMS_CHARS ? body.slice(0, MAX_SMS_CHARS - 1) + "…" : body;
    try {
      await this.d.sms.send(to, text);
      return true;
    } catch (err) {
      this.log(`couldn't text ${to}`, err);
      return false;
    }
  }

  /** Like send, but stays quiet for customers who've opted out. */
  private async sendCustomer(phone: string, body: string): Promise<boolean> {
    const conv = await this.d.store.getConversation(phone);
    if (conv.optedOut) return false;
    return this.send(phone, body);
  }

  private async notifyOwner(body: string) {
    await this.send(this.d.config.OWNER_PHONE, body);
  }

  private label(conv: Conversation) {
    return `${conv.customerName ?? "Customer"} (${conv.phone})`;
  }

  /* ---------------- inbound SMS ---------------- */

  async handleInboundSms(msg: { from: string; body: string; messageSid: string }): Promise<void> {
    if (!(await this.d.store.claimEvent(`twilio:${msg.messageSid}`))) return;
    const from = normalizePhone(msg.from);
    await this.withLock(from, () => this.processInbound(from, msg.body ?? ""));
  }

  private async processInbound(from: string, rawBody: string) {
    const { config, store } = this.d;
    const { text: body, found: hadCard } = redactCardNumbers(rawBody.trim());

    if (from === normalizePhone(config.OWNER_PHONE) && (await this.handleOwnerCommand(body))) return;

    const conv = await store.getConversation(from);
    const kw = keyword(body);

    if (kw === "stop") {
      conv.optedOut = true;
      conv.cart = [];
      await this.save(conv);
      await this.orders.retireAwaiting(from, "canceled"); // don't leave a payable link for someone we can't text
      return; // Twilio sends the carrier-required opt-out confirmation
    }
    if (conv.optedOut) {
      if (kw === "start") {
        conv.optedOut = false;
        await this.save(conv);
      }
      return;
    }

    // Staff have taken over this chat: pass messages along, don't let the bot answer.
    if (conv.humanUntil && conv.humanUntil > this.now()) {
      await this.notifyOwner(`💬 ${this.label(conv)}: ${body}\n(Reply: TO ${from.slice(-4)} your message)`);
      return;
    }

    if (kw === "human") {
      await this.startHandoff(conv, "Customer asked for a person");
      await this.save(conv);
      await this.sendCustomer(from, "No problem, someone from the team will text you back shortly.");
      return;
    }

    // Fresh start after a long quiet period: keep the name, drop stale chat and cart.
    if (conv.messages.length && this.now().getTime() - new Date(conv.updatedAt).getTime() > HISTORY_RESET_MS) {
      conv.messages = [];
      conv.cart = [];
      conv.pickupNote = null;
    }

    const agentDeps: AgentDeps = {
      model: this.d.model,
      modelName: config.ANTHROPIC_MODEL,
      menus: this.menus,
      orders: this.orders,
      store,
      businessName: config.BUSINESS_NAME,
      pickupInstructions: config.PICKUP_INSTRUCTIONS,
      orderingStatus: () => this.orderingStatus(),
      hoursText: describeHours(await this.hours()),
      handoff: (c, reason) => this.startHandoff(c, reason),
      now: this.now,
      timeZone: config.TIMEZONE,
    };

    let reply: string;
    try {
      const modelInput = hadCard ? `${body}\n\n(System note: the customer texted what looked like a card number; it was removed. Remind them never to text card details.)` : body;
      reply = (await runAgentTurn(agentDeps, conv, modelInput)).reply;
    } catch (err) {
      this.log("agent turn failed", err);
      reply = "Sorry, something went wrong on our end. Please try again in a minute, or order at the window.";
    }
    if (hadCard && !/card/i.test(reply)) {
      reply = `For your safety, please don't text card numbers. Pay only through the secure link.\n\n${reply}`;
    }
    await this.save(conv);
    await this.sendCustomer(from, reply);
  }

  private async startHandoff(conv: Conversation, reason: string) {
    conv.humanUntil = new Date(this.now().getTime() + HANDOFF_MS);
    const last = [...conv.messages].reverse().find((m) => m.role === "user" && typeof m.content === "string");
    await this.notifyOwner(
      `🙋 ${this.label(conv)} needs a person: ${reason}${last ? `\nLast message: "${last.content}"` : ""}\nReply: TO ${conv.phone.slice(-4)} your message · BOT ${conv.phone.slice(-4)} to hand back`,
    );
  }

  /* ---------------- owner commands ---------------- */

  /** Returns true if the owner's text was a command. Anything else is treated like a normal customer text (handy for testing). */
  private async handleOwnerCommand(body: string): Promise<boolean> {
    const { store } = this.d;
    const owner = this.d.config.OWNER_PHONE;
    const [cmdRaw, ...rest] = body.split(/\s+/);
    const cmd = (cmdRaw ?? "").toUpperCase();

    if (cmd === "PAUSE") {
      await store.setSetting("paused", "true");
      const n = await this.retireAllUnpaid("Text ordering just paused, so your payment link was cancelled. Please order at the window.");
      await this.send(owner, `Text ordering paused${n ? ` and ${n} unpaid link${n > 1 ? "s" : ""} cancelled` : ""}. Customers will be told to order at the window. Text RESUME to turn it back on.`);
      return true;
    }
    if (cmd === "RESUME") {
      await store.setSetting("paused", "false");
      await this.send(owner, "Text ordering is back on.");
      return true;
    }
    if (cmd === "STATUS") {
      const s = await this.orderingStatus();
      const active = await store.countActiveOrders();
      const recent = (await store.listOrders(10)).filter((o) => o.status === "paid" || o.status === "awaiting_payment");
      const lines = recent.map((o) => `#${o.orderNumber} ${formatMoney(o.totalCents, o.currency)} ${o.status === "paid" ? "PAID" : "unpaid"}`);
      await this.send(owner, `${s.message}\nPaid & waiting: ${active}/${this.d.config.MAX_ACTIVE_ORDERS}\n${lines.join("\n")}`.trim());
      return true;
    }
    if ((cmd === "TO" || cmd === "BOT") && rest[0]) {
      const found = await this.findConversationBySuffix(rest[0]);
      if (found === "ambiguous") {
        await this.send(owner, `More than one recent chat ends in ${rest[0]}. Use more digits, e.g. ${cmd} 8075551234.`);
        return true;
      }
      if (!found) {
        await this.send(owner, `No recent chat with a number ending in ${rest[0]}.`);
        return true;
      }
      const message = rest.slice(1).join(" ").trim();
      if (cmd === "TO" && !message) return true;
      await this.withLock(found.phone, async () => {
        const target = await store.getConversation(found.phone);
        if (cmd === "BOT") {
          target.humanUntil = null;
          await this.save(target);
          return;
        }
        target.humanUntil = new Date(this.now().getTime() + HANDOFF_MS);
        appendNote(target, "(staff took over the conversation)", `[Staff] ${message}`);
        await this.save(target);
      });
      if (cmd === "BOT") await this.send(owner, `The bot is answering ${this.label(found)} again.`);
      else if (!(await this.sendCustomer(found.phone, message))) await this.send(owner, `Couldn't text ${this.label(found)} (they may have opted out).`);
      return true;
    }
    return false;
  }

  private async findConversationBySuffix(suffix: string): Promise<Conversation | "ambiguous" | null> {
    const digits = suffix.replace(/\D/g, "");
    if (digits.length < 4) return null;
    const hits = (await this.d.store.listConversations(500)).filter((c) => c.phone.endsWith(digits));
    if (hits.length > 1) return "ambiguous";
    return hits[0] ?? null;
  }

  /* ---------------- Square events ---------------- */

  async handleSquareEvent(event: { event_id?: string; type?: string; data?: { object?: any } }): Promise<void> {
    if (!event.event_id) return;
    const key = `square:${event.event_id}`;
    if (!(await this.d.store.claimEvent(key))) return;
    try {
      await this.applySquareEvent(event);
    } catch (err) {
      await this.d.store.releaseEvent(key); // let Square's retry run it again
      throw err;
    }
  }

  private async applySquareEvent(event: { type?: string; data?: { object?: any } }) {
    const obj = event.data?.object ?? {};
    if (event.type === "payment.created" || event.type === "payment.updated") {
      const p = obj.payment;
      if (p?.status === "COMPLETED" && p.order_id) await this.onPaid(p.order_id);
      return;
    }
    if (event.type === "order.fulfillment.updated") {
      const u = obj.order_fulfillment_updated;
      const states: string[] = (u?.fulfillment_update ?? []).map((f: { new_state?: string }) => f.new_state ?? "");
      if (!u?.order_id) return;
      if (states.includes("PREPARED")) await this.onReady(u.order_id);
      else if (states.includes("COMPLETED")) await this.onPickedUp(u.order_id);
      else if (states.includes("CANCELED")) await this.onCanceled(u.order_id);
    }
  }

  private async onPaid(squareOrderId: string) {
    const found = await this.d.store.getOrderBySquareId(squareOrderId);
    if (!found) return;
    // Atomic: if payment.created and payment.updated race, only one gets past this.
    const order = await this.d.store.transitionOrder(found.id, ["awaiting_payment", "expired", "replaced", "canceled"], {
      status: "paid",
      paidAt: this.now(),
    });
    if (!order) return;

    let note = "";
    if (found.status !== "awaiting_payment") {
      // An old link got paid (e.g. an open checkout tab racing an edit). Kill the newer link so they can't pay twice.
      const newer = await this.orders.retireAwaiting(order.phone, "replaced");
      note = newer ? ` That was your earlier link, so we cancelled the newer one (#${newer.orderNumber}); don't pay it.` : "";
      await this.notifyOwner(
        `⚠️ Order #${order.orderNumber} was paid after its link was ${found.status}.${newer ? ` Newer unpaid link #${newer.orderNumber} cancelled.` : ""} Check it matches what ${order.phone} wanted.`,
      );
    }
    await this.withLock(order.phone, async () => {
      const conv = await this.d.store.getConversation(order.phone);
      conv.cart = [];
      appendNote(conv, `(system: payment received for order #${order.orderNumber})`, `Paid. Order #${order.orderNumber} sent to the kitchen.`);
      await this.save(conv);
    });
    await this.sendCustomer(order.phone, `Paid, thanks! Your order number is #${order.orderNumber}. We'll text you when it's ready.${note}`);
  }

  private async onReady(squareOrderId: string) {
    let found = await this.d.store.getOrderBySquareId(squareOrderId);
    if (!found) return;
    if (found.status === "awaiting_payment") {
      await this.onPaid(squareOrderId); // ready arrived before the payment event
      found = await this.d.store.getOrderBySquareId(squareOrderId);
      if (!found) return;
    }
    const order = await this.d.store.transitionOrder(found.id, ["paid"], { status: "ready", readyAt: this.now() });
    if (!order) return;
    const text = `Order #${order.orderNumber} is ready! ${this.d.config.PICKUP_INSTRUCTIONS}`;
    await this.noteInChat(order.phone, `(system: order #${order.orderNumber} is ready for pickup; the customer was texted)`, text);
    await this.sendCustomer(order.phone, text);
  }

  private async onPickedUp(squareOrderId: string) {
    const found = await this.d.store.getOrderBySquareId(squareOrderId);
    if (!found) return;
    const order = await this.d.store.transitionOrder(found.id, ["paid", "ready"], { status: "picked_up" });
    if (order) await this.noteInChat(order.phone, `(system: staff marked order #${order.orderNumber} as picked up)`, `Order #${order.orderNumber} picked up.`);
  }

  /** Records an order update in the customer's chat so the AI doesn't contradict it later. */
  private async noteInChat(phone: string, userNote: string, assistantText: string) {
    await this.withLock(phone, async () => {
      const conv = await this.d.store.getConversation(phone);
      appendNote(conv, userNote, assistantText);
      await this.save(conv);
    });
  }

  private async onCanceled(squareOrderId: string) {
    const found = await this.d.store.getOrderBySquareId(squareOrderId);
    if (!found) return;
    const order = await this.d.store.transitionOrder(found.id, ["awaiting_payment", "paid", "ready"], { status: "canceled" });
    if (order?.paidAt) {
      const text = `Order #${order.orderNumber} was canceled by the canteen. Reply here if you have questions about your refund.`;
      await this.noteInChat(order.phone, `(system: staff canceled paid order #${order.orderNumber}; the customer was texted)`, text);
      await this.sendCustomer(order.phone, text);
    }
  }

  /* ---------------- housekeeping ---------------- */

  /** Kills unpaid links older than CART_EXPIRY_MINUTES, and every unpaid link once ordering is closed or paused. Call every minute. */
  async expireStaleLinks(): Promise<number> {
    const status = await this.orderingStatus();
    if (!status.open) {
      return this.retireAllUnpaid("Text ordering has closed, so your unpaid order was cancelled. Thanks for checking us out!");
    }
    const cutoff = new Date(this.now().getTime() - this.d.config.CART_EXPIRY_MINUTES * 60_000);
    let n = 0;
    for (const o of await this.d.store.listAwaitingCreatedBefore(cutoff)) {
      try {
        if (await this.orders.retire(o, "expired")) {
          n++;
          await this.sendCustomer(o.phone, `Your payment link for order #${o.orderNumber} expired. Text us again if you still want it.`);
        }
      } catch (err) {
        this.log(`couldn't expire order ${o.id}`, err);
      }
    }
    return n;
  }

  private async retireAllUnpaid(message: string): Promise<number> {
    let n = 0;
    for (const o of await this.d.store.listAwaitingCreatedBefore(new Date(this.now().getTime() + 1000))) {
      try {
        if (await this.orders.retire(o, "canceled")) {
          n++;
          await this.sendCustomer(o.phone, message);
        }
      } catch (err) {
        this.log(`couldn't cancel order ${o.id}`, err);
      }
    }
    return n;
  }
}

/** Adds a system note + assistant line to the chat history without breaking user/assistant alternation. */
function appendNote(conv: Conversation, userNote: string, assistantText: string) {
  const last = conv.messages.at(-1);
  if (last?.role === "user") {
    const blocks = typeof last.content === "string" ? [{ type: "text", text: last.content }] : (last.content as unknown[]);
    last.content = [...blocks, { type: "text", text: userNote }];
  } else {
    conv.messages.push({ role: "user", content: userNote });
  }
  conv.messages.push({ role: "assistant", content: [{ type: "text", text: assistantText }] });
}
