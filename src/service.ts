import { runAgentTurn, type AgentDeps, type ModelClient } from "./agent.js";
import type { Config } from "./config.js";
import { describeHours, isOpen, keyword, nextOpeningText, normalizePhone, redactCardNumbers } from "./guards.js";
import { CustomerService } from "./customers.js";
import { fetchScorebar, type FeedGame } from "./game/hockeytech.js";
import { GameService, ordinal } from "./game/service.js";
import type { Timeline } from "./game/timeline.js";
import { HoursService } from "./hours.js";
import { LoyaltyService } from "./loyalty.js";
import { resolvePickup, shortTime, type ResolvedPickup } from "./pickup.js";
import { reconcileSchedule } from "./schedule.js";
import { OrderService } from "./orders.js";
import type { SquareApi } from "./square/client.js";
import { formatMoney, MenuService } from "./square/menu.js";
import type { SmsSender } from "./sms.js";
import type { Conversation, OrderRecord, PickupTarget, Store } from "./store/types.js";

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
  /** Tests inject the feed; production fetches HockeyTech. */
  fetchGames?: () => Promise<FeedGame[]>;
}

/** Everything the webhooks call into. No HTTP here, so it can be tested directly. */
export class TextOrderService {
  readonly menus: MenuService;
  readonly orders: OrderService;
  readonly hoursService: HoursService;
  readonly customers: CustomerService;
  readonly loyalty: LoyaltyService;
  /** Null when the HockeyTech settings aren't all set. */
  readonly game: GameService | null;
  private locks = new Map<string, Promise<unknown>>();
  /** Arrival order of inbound texts, so consent can't come from a text queued before an offer was sent. */
  private lastSeq = 0;
  /** Orders the owner was already told Square wouldn't move (one alert each). */
  private scheduleAlerted = new Set<string>();
  private now: () => Date;
  private log: (msg: string, extra?: unknown) => void;

  constructor(private d: ServiceDeps) {
    this.now = d.now ?? (() => new Date());
    this.log = d.log ?? ((m, e) => console.log(m, e ?? ""));
    this.menus = new MenuService(d.square, d.config.SQUARE_LOCATION_ID);
    this.hoursService = new HoursService(d.square, d.config.hours);
    this.customers = new CustomerService(d.square, () => this.now(), (m, e) => this.log(m, e));
    this.loyalty = new LoyaltyService(d.square, d.config.SQUARE_LOCATION_ID, (m, e) => this.log(m, e));
    const { HOCKEYTECH_KEY: key, HOCKEYTECH_CLIENT_CODE: clientCode, HOCKEYTECH_TEAM_ID: teamId } = d.config;
    this.game =
      d.fetchGames || (key && clientCode && teamId)
        ? new GameService({
            fetchGames: d.fetchGames ?? (() => fetchScorebar({ key: key!, clientCode: clientCode! })),
            store: d.store,
            teamId: teamId ?? null,
            tz: d.config.TIMEZONE,
            now: () => this.now(),
            secondsPerClockMinute: d.config.GAME_SECONDS_PER_CLOCK_MINUTE,
            intermissionMinutes: d.config.GAME_INTERMISSION_MINUTES,
            notifyOwner: (t) => this.notifyOwner(t),
            onTimelineChange: (prev, next) => this.onTimelineChange(prev, next),
            log: (m, e) => this.log(m, e),
          })
        : null;
    this.orders = new OrderService({
      square: d.square,
      menus: this.menus,
      store: d.store,
      locationId: d.config.SQUARE_LOCATION_ID,
      maxActiveOrders: d.config.MAX_ACTIVE_ORDERS,
      intermissionCapacity: d.config.INTERMISSION_CAPACITY,
      prepMinutes: d.config.PREP_MINUTES,
      pickup: (conv) => this.resolve(conv.pickupTarget ?? { kind: "asap" }),
      allowTipping: d.config.ALLOW_TIPPING,
      oneTapMaxCents: d.config.ONE_TAP_MAX_CENTS,
      oneTapDailyMaxCents: d.config.ONE_TAP_DAILY_MAX_CENTS,
      refreshCustomer: (conv) => this.customers.refresh(conv, { force: true }),
      timeZone: d.config.TIMEZONE,
      ensureCustomer: (conv) => this.customers.ensureProfile(conv, `customer:${conv.phone}`),
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

  /** A pickup target against the current game state. */
  resolve(t: PickupTarget): ResolvedPickup {
    const game = this.game?.homeGameToday() ?? null;
    const today = game ? { game, timeline: this.game!.state()?.timeline ?? null } : null;
    const hours = this.hoursService.peek();
    const tz = this.d.config.TIMEZONE;
    return resolvePickup(t, today, this.game?.usable() ?? false, this.now(), tz, (d) => isOpen(hours, d, tz));
  }

  /** Called by the game poller whenever the intermission estimate changes: scheduled orders follow the game. */
  private async onTimelineChange(prev: Timeline | null, next: Timeline): Promise<void> {
    await reconcileSchedule(
      {
        square: this.d.square,
        store: this.d.store,
        now: () => this.now(),
        tz: this.d.config.TIMEZONE,
        sendCustomer: (p, t) => this.sendCustomer(p, t),
        notifyOwner: (t) => this.notifyOwner(t),
        alerted: this.scheduleAlerted,
      },
      prev,
      next,
    );
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
    this.lastSeq = Math.max(this.lastSeq + 1, Date.now() * 1000);
    const seq = this.lastSeq; // taken before waiting for the lock
    const paid = await this.withLock(from, () => this.processInbound(from, msg.body ?? "", msg.messageSid, seq));
    // A saved card was charged during that turn. Marking it paid takes the same lock, so do it now it's released.
    if (paid) await this.markPaid(paid);
  }

  /** Returns the Square order id if a saved card was charged during this turn. */
  private async processInbound(from: string, rawBody: string, messageSid: string, seq: number): Promise<string | undefined> {
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
      conv.pickupTarget = null;
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
      gameSummary: () => this.game?.describe(config.TIMEZONE) ?? "No game clock (feed not set up).",
      resolvePickup: (t) => this.resolve(t),
      inbound: { text: body, turnId: messageSid, seq },
      onCharged: (order, summary, card) => (charged = { order, summary, card }),
      loyalty: this.loyalty,
      forgetCard: async (c, card) => {
        for (const id of [card.id, ...(card.otherIds ?? [])]) await this.d.square.disableCard(id);
        c.savedCards = (c.savedCards ?? []).filter((x) => x.id !== card.id);
        c.savedCard = c.savedCards[0] ?? null;
        c.pendingOneTap = null;
      },
    };

    await this.customers.refresh(conv);

    let reply: string;
    let paidSquareOrderId: string | undefined;
    let charged: { order: OrderRecord; summary: string; card: string } | null = null;
    let offerShown = false;
    try {
      const modelInput = hadCard ? `${body}\n\n(System note: the customer texted what looked like a card number; it was removed. Remind them never to text card details.)` : body;
      const turn = await runAgentTurn(agentDeps, conv, modelInput);
      reply = turn.reply;
      paidSquareOrderId = turn.paidSquareOrderId;
      offerShown = !!turn.offerShown;
    } catch (err) {
      this.log("agent turn failed", err);
      const c = charged as { order: OrderRecord; summary: string; card: string } | null;
      if (c) {
        // The card was charged before the AI failed: never tell them to try again.
        reply = `${c.summary}\n\nCharged to ${c.card}. Order #${c.order.orderNumber}.`;
        paidSquareOrderId = c.order.squareOrderId;
      } else {
        reply = "Sorry, something went wrong on our end. Please try again in a minute, or order at the window.";
      }
    }
    if (hadCard && !/card/i.test(reply)) {
      reply = `For your safety, please don't text card numbers. Pay only through the secure link.\n\n${reply}`;
    }
    // An offer made this turn counts only if the code-written question actually reached the customer.
    if (conv.pendingOneTap?.turnId === messageSid && !offerShown) conv.pendingOneTap = null;
    await this.save(conv);
    const sent = await this.sendCustomer(from, reply);
    if (conv.pendingOneTap?.turnId === messageSid) {
      if (sent) conv.pendingOneTap.shownAfterSeq = this.lastSeq; // texts that arrived before this send can't say Y to it
      else conv.pendingOneTap = null;
      await this.save(conv);
    }
    return paidSquareOrderId;
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
  /** Game line plus orders per game slot, for STATUS. */
  private async gameStatusLines(): Promise<string> {
    if (!this.game) return "Game feed: off";
    const desc = this.game.describe(this.d.config.TIMEZONE);
    const g = this.game.homeGameToday();
    if (!g) return desc;
    const live = (await this.d.store.listOrdersInSlotPrefix(`game:${g.id}:`)).filter((o) => o.status === "paid" || o.status === "awaiting_payment");
    const n = (slot: string) => live.filter((o) => o.pickupSlot === `game:${g.id}:${slot}`).length;
    return `${desc}\nint1: ${n("int1")} · int2: ${n("int2")} · after: ${n("end")}`;
  }

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
      await this.send(owner, `${s.message}\nPaid & waiting: ${active}/${this.d.config.MAX_ACTIVE_ORDERS}\n${await this.gameStatusLines()}\n${lines.join("\n")}`.trim());
      return true;
    }
    if (cmd === "GAME") {
      await this.send(owner, this.game ? this.game.describe(this.d.config.TIMEZONE) : "Game feed: off");
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
    if (event.type === "invoice.payment_made") {
      const orderId = obj.invoice?.order_id;
      if (orderId) await this.onPaid(orderId);
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

  /** Marks a Square order paid (from a webhook or a saved-card charge). Safe to call twice. */
  async markPaid(squareOrderId: string) {
    return this.onPaid(squareOrderId);
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
      conv.pickupTarget = null; // the next order starts back at right away
      if (!conv.squareCustomerId && !conv.customerAmbiguous) {
        await this.customers.ensureProfile(conv, `customer:${order.id}`).catch((err) => this.log("couldn't create Square customer", err));
      }
      conv.customerLookupAt = null; // pick up a newly saved card on the next text
      appendNote(conv, `(system: payment received for order #${order.orderNumber})`, `Paid. Order #${order.orderNumber} sent to the kitchen.`);
      await this.save(conv);
    });
    await this.sendCustomer(order.phone, `${await this.paidText(order)}${note}`);
  }

  /** "Paid, thanks! Order #12. You're 3rd for the 2nd intermission, ready about 8:28. ..." */
  private async paidText(order: OrderRecord): Promise<string> {
    const tail = "We'll text you when it's ready.";
    const slot = order.pickupSlot ?? "asap";
    if (slot.startsWith("game:") && order.pickupAt) {
      const ahead = (await this.d.store.listOrdersInSlotPrefix(slot)).filter(
        (o) => o.pickupSlot === slot && o.id !== order.id && o.paidAt && order.paidAt && o.paidAt <= order.paidAt && ["paid", "ready", "picked_up"].includes(o.status),
      ).length;
      const label = slot.endsWith(":end") ? "after the game" : `the ${ordinal(Number(slot.slice(-1)))} intermission`;
      return `Paid, thanks! Order #${order.orderNumber}. You're ${ordinal(ahead + 1)} for ${label}, ready about ${shortTime(order.pickupAt, this.d.config.TIMEZONE)}. ${tail}`;
    }
    if (slot.startsWith("clock") && order.pickupAt) {
      return `Paid, thanks! Order #${order.orderNumber}. Ready about ${shortTime(order.pickupAt, this.d.config.TIMEZONE)}. ${tail}`;
    }
    const inLine = await this.d.store.countActiveAsapOrders(this.now());
    return `Paid, thanks! Order #${order.orderNumber}. You're ${ordinal(Math.max(1, inLine))} in line. ${tail}`;
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
    if (order) {
      const conv = await this.d.store.getConversation(order.phone);
      if (conv.loyaltyAccountId && order.customerId) await this.loyalty.accumulate(order, conv.loyaltyAccountId); // members only, at pickup
    }
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
    const paused = (await this.d.store.getSetting("paused")) === "true";
    // Hours we couldn't load yet (Square hiccup after a restart) aren't "closed": don't cancel everyone's links.
    if (!status.open && (paused || this.hoursService.isKnown())) {
      return this.retireAllUnpaid("Text ordering has closed, so your unpaid order was cancelled. Thanks for checking us out!");
    }
    const cutoff = new Date(this.now().getTime() - this.d.config.CART_EXPIRY_MINUTES * 60_000);
    let n = 0;
    for (const o of await this.d.store.listAwaitingCreatedBefore(cutoff)) {
      try {
        if (o.checkoutKind === "card_on_file") {
          if (await this.settleCardCharge(o)) n++;
          continue;
        }
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

  /** An unclear saved-card charge: mark it paid if Square took the money, expire it only if Square shows no charge. */
  private async settleCardCharge(o: OrderRecord): Promise<boolean> {
    const outcome = await this.orders.cardChargeOutcome(o);
    if (outcome === "paid") {
      await this.markPaid(o.squareOrderId);
      return true;
    }
    if (outcome === "unpaid" && (await this.orders.retire(o, "expired"))) {
      await this.sendCustomer(o.phone, `Square shows no charge for order #${o.orderNumber}, so it was cancelled. Text us again if you still want it.`);
      return true;
    }
    return false; // Square unreachable: try again on the next sweep
  }

  private async retireAllUnpaid(message: string): Promise<number> {
    let n = 0;
    for (const o of await this.d.store.listAwaitingCreatedBefore(new Date(this.now().getTime() + 1000))) {
      if (o.checkoutKind === "card_on_file") {
        if (await this.settleCardCharge(o).catch(() => false)) n++;
        continue;
      }
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
