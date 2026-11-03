import { beforeEach, describe, expect, it } from "vitest";
import { buildApp, SQUARE_PATH, TWILIO_PATH } from "../src/app.js";
import { TextOrderService } from "../src/service.js";
import { signSquareBody } from "../src/square/webhook.js";
import { MemoryStore } from "../src/store/memory.js";
import { FakeSms, FakeSquare, ScriptedModel, say, testConfig, tool } from "./fakes.js";

const CUSTOMER = "+18075551234";
const OWNER = "+18075550100";

let sid = 0;
function setup(configOverrides: Record<string, string> = {}, now = new Date("2026-11-03T23:42:00Z")) {
  const config = testConfig(configOverrides);
  const store = new MemoryStore();
  const square = new FakeSquare();
  const sms = new FakeSms();
  const model = new ScriptedModel();
  let clock = now;
  const service = new TextOrderService({ config, store, square, sms, model, now: () => clock, log: () => {} });
  const text = (body: string, from = CUSTOMER) => service.handleInboundSms({ from, body, messageSid: `SM${++sid}` });
  const squareEvent = (type: string, object: unknown, id = `evt${++sid}`) => service.handleSquareEvent({ event_id: id, type, data: { object } });
  return { config, store, square, sms, model, service, text, squareEvent, setClock: (d: Date) => (clock = d) };
}

const ORDER_LINES = {
  lines: [
    { variation_id: "V_POUTINE", quantity: 2 },
    { variation_id: "V_FRIES_L", quantity: 1 },
    { variation_id: "V_SODA", quantity: 1, modifier_ids: ["MOD_DRP", "MOD_COCO"] },
  ],
};

describe("a full text order", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    t = setup();
  });

  it("goes from a plain-language text to a paid, ready order", async () => {
    // 1. Customer texts an order. AI sets the cart, then reads it back.
    t.model.push(
      tool("set_cart", ORDER_LINES),
      tool("set_pickup_details", { pickup_note: "after 2nd period" }),
      say("2 poutines, a large fries and a Dr Pepper dirty soda with coconut. What name should I put on it?"),
    );
    await t.text("hey can i get 2 poutines, a large fries and a dirty dr pepper w coconut. pickup after 2nd period");

    // The model saw the live menu and Square's own pricing came back from set_cart.
    const firstSystem = t.model.requests[0]!.system;
    expect(firstSystem).toContain("id=V_POUTINE $9.00");
    const setCartResult = JSON.stringify(t.model.requests[1]!.messages.at(-1));
    expect(setCartResult).toContain("Total $33.34");
    expect(t.sms.last(CUSTOMER)).toMatch(/What name/);

    // 2. Customer gives a name and confirms. AI sends the link; summary is added by code, not the AI.
    t.model.push(tool("set_pickup_details", { customer_name: "Jordan" }), tool("send_checkout_link"), say("Thanks Jordan! Here's your order."));
    await t.text("Jordan. that's it");

    const reply = t.sms.last(CUSTOMER);
    expect(reply).toContain("Thanks Jordan! Here's your order.");
    expect(reply).toContain("2 × Poutine · $18.00");
    expect(reply).toContain("   + Coconut");
    expect(reply).toContain("Total $33.34");
    expect(reply).toContain("https://square.link/u/test1");

    const link = t.square.links.get("PL1")!;
    expect(link.order.fulfillments?.[0]).toMatchObject({
      type: "PICKUP",
      pickup_details: { recipient: { display_name: "Jordan" }, note: "Text order #1 · after 2nd period" },
    });

    // 3. Square says it's paid.
    await t.squareEvent("payment.updated", { payment: { status: "COMPLETED", order_id: "SQORD1" } });
    expect(t.sms.last(CUSTOMER)).toBe("Paid, thanks! Order #1. You're 1st in line. We'll text you when it's ready.");
    expect((await t.store.getOrderBySquareId("SQORD1"))!.status).toBe("paid");
    expect((await t.store.getConversation(CUSTOMER)).cart).toEqual([]);

    // Square retries the same event: no double text.
    const before = t.sms.sent.length;
    await t.service.handleSquareEvent({ event_id: "dup", type: "payment.updated", data: { object: { payment: { status: "COMPLETED", order_id: "SQORD1" } } } });
    await t.service.handleSquareEvent({ event_id: "dup", type: "payment.updated", data: { object: { payment: { status: "COMPLETED", order_id: "SQORD1" } } } });
    expect(t.sms.sent.length).toBe(before);

    // 4. Staff mark it ready in Square.
    await t.squareEvent("order.fulfillment.updated", {
      order_fulfillment_updated: { order_id: "SQORD1", fulfillment_update: [{ old_state: "RESERVED", new_state: "PREPARED" }] },
    });
    expect(t.sms.last(CUSTOMER)).toBe("Order #1 is ready! Pick up at the canteen window.");
    expect((await t.store.getOrderBySquareId("SQORD1"))!.status).toBe("ready");
  });

  it("the AI knows when an order went ready or was picked up, even mid-chat", async () => {
    t.model.push(tool("set_cart", ORDER_LINES), tool("set_pickup_details", { customer_name: "Jordan" }), tool("send_checkout_link"), say("Here's your order."));
    await t.text("2 poutines, large fries, dirty dr pepper w coconut. Jordan. send it");
    await t.squareEvent("payment.updated", { payment: { status: "COMPLETED", order_id: "SQORD1" } });

    t.model.push(say("Nope, no slushies."));
    await t.text("also a blue slushie?");
    expect(t.model.requests.at(-1)!.system).toMatch(/#1 · \$33\.34 · paid, being made/);

    await t.squareEvent("order.fulfillment.updated", {
      order_fulfillment_updated: { order_id: "SQORD1", fulfillment_update: [{ new_state: "PREPARED" }] },
    });
    t.model.push(say("It's ready at the window."));
    await t.text("is it done?");
    const req = t.model.requests.at(-1)!;
    expect(req.system).toMatch(/#1 · \$33\.34 · ready for pickup/);
    expect(JSON.stringify(req.messages)).toContain("order #1 is ready for pickup");

    await t.squareEvent("order.fulfillment.updated", {
      order_fulfillment_updated: { order_id: "SQORD1", fulfillment_update: [{ new_state: "COMPLETED" }] },
    });
    t.model.push(say("Enjoy!"));
    await t.text("got it thanks");
    expect(t.model.requests.at(-1)!.system).toMatch(/#1 · \$33\.34 · picked up/);
  });

  it("an edit replaces the old link so a stale total can't be paid", async () => {
    t.model.push(tool("set_cart", ORDER_LINES), tool("send_checkout_link"), say("Here you go."));
    await t.text("2 poutines large fries dirty dr pepper coconut, send it");
    expect(t.sms.last(CUSTOMER)).toContain("Total $33.34");

    t.model.push(
      tool("set_cart", {
        lines: [{ variation_id: "V_POUTINE", quantity: 2, modifier_ids: ["MOD_CURDS"] }, ...ORDER_LINES.lines.slice(1)],
      }),
      tool("send_checkout_link"),
      say("Updated. The old link won't work anymore."),
    );
    await t.text("make the poutines extra curds");
    expect(t.square.calls).toContain("deletePaymentLink:PL1");
    expect(t.square.links.get("PL1")!.deleted).toBe(true);
    expect(t.sms.last(CUSTOMER)).toContain("https://square.link/u/test2");
    expect(t.sms.last(CUSTOMER)).toContain("Total $36.73"); // 3.00 more for 2× extra curds + tax
    const orders = await t.store.listOrders(10);
    expect(orders.map((o) => o.status).sort()).toEqual(["awaiting_payment", "replaced"]);
  });

  it("tells the AI about problems instead of letting it invent an order", async () => {
    t.model.push(
      tool("set_cart", { lines: [{ variation_id: "V_MOZZA", quantity: 1 }] }),
      say("Sorry, we're out of mozza sticks tonight. Want fries instead?"),
    );
    await t.text("mozza sticks pls");
    expect(JSON.stringify(t.model.requests[1]!.messages.at(-1))).toContain("Mozza Sticks is sold out");
    expect(t.sms.last(CUSTOMER)).toMatch(/out of mozza sticks/);
  });

  it("refuses a link when the cart has problems even if the AI tries", async () => {
    t.model.push(tool("set_cart", { lines: [{ variation_id: "V_SODA", quantity: 1 }] }), tool("send_checkout_link"), say("Which soda base?"));
    await t.text("dirty soda, send link");
    expect(t.square.calls).not.toContain("createPaymentLink");
    expect(JSON.stringify(t.model.requests[2]!.messages.at(-1))).toMatch(/Link not created.*Soda base/);
  });

  it("strips card numbers before the AI or the database sees them", async () => {
    t.model.push(say("Please don't text card details! You'll pay through a secure link."));
    await t.text("here's my card 4111 1111 1111 1111");
    const seen = JSON.stringify(t.model.requests[0]!.messages);
    expect(seen).not.toContain("4111");
    expect(seen).toContain("[card number removed]");
    expect(JSON.stringify(t.store.conversations.get(CUSTOMER))).not.toContain("4111");
  });

  it("expires unpaid links after the time limit", async () => {
    t.model.push(tool("set_cart", ORDER_LINES), tool("send_checkout_link"), say("Here you go."));
    await t.text("order, send it");
    expect(await t.service.expireStaleLinks()).toBe(0);
    t.setClock(new Date("2026-11-04T00:05:00Z")); // 23 min later
    expect(await t.service.expireStaleLinks()).toBe(1);
    expect(t.square.links.get("PL1")!.deleted).toBe(true);
    expect(t.sms.last(CUSTOMER)).toMatch(/expired/);
  });

  it("a payment on a retired link is still honoured and staff are warned", async () => {
    t.model.push(tool("set_cart", ORDER_LINES), tool("send_checkout_link"), say("ok"));
    await t.text("order");
    t.setClock(new Date("2026-11-04T00:05:00Z"));
    await t.service.expireStaleLinks();
    await t.squareEvent("payment.updated", { payment: { status: "COMPLETED", order_id: "SQORD1" } });
    expect(t.sms.last(OWNER)).toMatch(/paid after its link was expired/);
    expect((await t.store.getOrderBySquareId("SQORD1"))!.status).toBe("paid");
  });
});

describe("hours, pausing and capacity", () => {
  it("won't create a link outside ordering hours", async () => {
    const t = setup({ ORDERING_HOURS: "sat=18:00-23:00" });
    t.model.push(tool("set_cart", ORDER_LINES), tool("send_checkout_link"), say("Sorry, we're closed right now."));
    await t.text("2 poutines send it");
    expect(t.square.calls).not.toContain("createPaymentLink");
    expect(JSON.stringify(t.model.requests[2]!.messages.at(-1))).toContain("opens Saturday at 6pm");
    expect(t.model.requests[0]!.system).toContain("Text ordering is closed right now");
  });

  it("owner can PAUSE and RESUME from their phone", async () => {
    const t = setup();
    await t.text("pause", OWNER);
    expect(t.sms.last(OWNER)).toMatch(/paused/);
    t.model.push(tool("set_cart", ORDER_LINES), tool("send_checkout_link"), say("Paused, order at the window."));
    await t.text("order pls");
    expect(t.square.calls).not.toContain("createPaymentLink");
    await t.text("RESUME", OWNER);
    expect((await t.service.orderingStatus()).open).toBe(true);
    await t.text("STATUS", OWNER);
    expect(t.sms.last(OWNER)).toMatch(/Text ordering is open\.\nPaid & waiting: 0\/15/);
  });

  it("stops taking text orders when the kitchen is full", async () => {
    const t = setup({ MAX_ACTIVE_ORDERS: "1" });
    t.model.push(tool("set_cart", ORDER_LINES), tool("send_checkout_link"), say("ok"));
    await t.text("order");
    await t.squareEvent("payment.updated", { payment: { status: "COMPLETED", order_id: "SQORD1" } });
    t.model.push(tool("set_cart", ORDER_LINES), tool("send_checkout_link"), say("Kitchen's full, try soon."));
    await t.text("another order", "+18075559999");
    expect(t.square.calls.filter((c) => c === "createPaymentLink").length).toBe(1);
    expect(JSON.stringify(t.model.requests.at(-1)!.messages)).toContain("at its limit");
  });
});

describe("people and opt-outs", () => {
  it("HUMAN hands the chat to the owner, who can reply and hand it back", async () => {
    const t = setup();
    await t.text("human");
    expect(t.sms.last(CUSTOMER)).toMatch(/someone from the team/);
    expect(t.sms.last(OWNER)).toMatch(/needs a person/);

    await t.text("my fries were cold");
    expect(t.model.requests.length).toBe(0); // bot stays quiet
    expect(t.sms.last(OWNER)).toContain("my fries were cold");

    await t.text("TO 1234 Sorry about that! Grab a fresh order at the window on us.", OWNER);
    expect(t.sms.last(CUSTOMER)).toBe("Sorry about that! Grab a fresh order at the window on us.");

    await t.text("BOT 1234", OWNER);
    t.model.push(say("Hi again! What can I get you?"));
    await t.text("thanks! can I order now");
    expect(t.sms.last(CUSTOMER)).toBe("Hi again! What can I get you?");
  });

  it("the AI can hand off too", async () => {
    const t = setup();
    t.model.push(tool("handoff_to_human", { reason: "Allergy question about the fryer oil" }), say("Good question, I've asked the team. Someone will text you shortly."));
    await t.text("is your fryer oil peanut free? my kid has an allergy");
    expect(t.sms.last(OWNER)).toMatch(/Allergy question/);
  });

  it("STOP opts out and the bot goes silent until START", async () => {
    const t = setup();
    await t.text("STOP");
    await t.text("2 poutines");
    expect(t.sms.to(CUSTOMER)).toEqual([]);
    expect(t.model.requests.length).toBe(0);
    await t.text("START");
    t.model.push(say("Welcome back!"));
    await t.text("hi");
    expect(t.sms.last(CUSTOMER)).toBe("Welcome back!");
  });

  it("the same Twilio message delivered twice is answered once", async () => {
    const t = setup();
    t.model.push(say("Hi!"));
    await t.service.handleInboundSms({ from: CUSTOMER, body: "hi", messageSid: "SMdup" });
    await t.service.handleInboundSms({ from: CUSTOMER, body: "hi", messageSid: "SMdup" });
    expect(t.sms.to(CUSTOMER)).toEqual(["Hi!"]);
  });

  it("if the AI service fails, the customer gets a polite fallback", async () => {
    const t = setup();
    await t.text("hello"); // model has no scripted steps -> throws
    expect(t.sms.last(CUSTOMER)).toMatch(/something went wrong/);
  });
});

describe("HTTP endpoints", () => {
  it("rejects unsigned Twilio and Square webhooks, accepts signed Square ones", async () => {
    const t = setup();
    const app = buildApp({ config: t.config, service: t.service, store: t.store, logger: false });

    const tw = await app.inject({ method: "POST", url: TWILIO_PATH, payload: "From=%2B18075551234&Body=hi&MessageSid=SM1", headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(tw.statusCode).toBe(403);

    const body = JSON.stringify({ event_id: "e1", type: "payment.updated", data: { object: { payment: { status: "COMPLETED", order_id: "nope" } } } });
    const bad = await app.inject({ method: "POST", url: SQUARE_PATH, payload: body, headers: { "content-type": "application/json", "x-square-hmacsha256-signature": "nope" } });
    expect(bad.statusCode).toBe(403);

    const sig = signSquareBody(t.config.SQUARE_WEBHOOK_SIGNATURE_KEY, t.config.PUBLIC_BASE_URL + SQUARE_PATH, body);
    const good = await app.inject({ method: "POST", url: SQUARE_PATH, payload: body, headers: { "content-type": "application/json", "x-square-hmacsha256-signature": sig } });
    expect(good.statusCode).toBe(200);

    const admin = await app.inject({ method: "GET", url: "/admin/status" });
    expect(admin.statusCode).toBe(401);
    const admin2 = await app.inject({ method: "GET", url: "/admin/status", headers: { authorization: `Bearer ${t.config.ADMIN_TOKEN}` } });
    expect(admin2.json()).toMatchObject({ open: true, activeOrders: 0 });
    await app.close();
  });

  it("accepts a correctly signed Twilio webhook", async () => {
    const t = setup();
    t.model.push(say("Hey! What can I get you?"));
    const app = buildApp({ config: t.config, service: t.service, store: t.store, logger: false });
    const params = { From: CUSTOMER, Body: "hi", MessageSid: "SMsigned" };
    const twilio = (await import("twilio")).default;
    const sig = twilio.getExpectedTwilioSignature(t.config.TWILIO_AUTH_TOKEN, t.config.PUBLIC_BASE_URL + TWILIO_PATH, params);
    const res = await app.inject({
      method: "POST",
      url: TWILIO_PATH,
      payload: new URLSearchParams(params).toString(),
      headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": sig },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("<Response>");
    await new Promise((r) => setTimeout(r, 20));
    expect(t.sms.last(CUSTOMER)).toBe("Hey! What can I get you?");
    await app.close();
  });
});
