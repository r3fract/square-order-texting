import { describe, expect, it } from "vitest";
import { dollarAmounts, type ModelRequest } from "../src/agent.js";
import { TextOrderService } from "../src/service.js";
import { MemoryStore } from "../src/store/memory.js";
import { FakeSms, FakeSquare, ScriptedModel, say, testConfig, tool } from "./fakes.js";

const CUSTOMER = "+18075551234";
const OWNER = "+18075550100";
const LINES = { lines: [{ variation_id: "V_POUTINE", quantity: 2 }] }; // 2 × 9.00 + 13% = $20.34

let sid = 0;
function setup(overrides: Record<string, string> = {}) {
  const config = testConfig(overrides);
  const store = new MemoryStore();
  const square = new FakeSquare();
  const sms = new FakeSms();
  const model = new ScriptedModel();
  let clock = new Date("2026-11-03T23:42:00Z");
  const service = new TextOrderService({ config, store, square, sms, model, now: () => clock, log: () => {} });
  const text = (body: string, from = CUSTOMER) => service.handleInboundSms({ from, body, messageSid: `H${++sid}` });
  const paid = (orderId: string, type = "payment.updated", id = `ev${++sid}`) =>
    service.handleSquareEvent({ event_id: id, type, data: { object: { payment: { status: "COMPLETED", order_id: orderId } } } });
  const order = async (from = CUSTOMER) => {
    model.push(tool("set_cart", LINES), tool("send_checkout_link"), say("Here you go."));
    await text("2 poutines, send it", from);
  };
  return { config, store, square, sms, model, service, text, paid, order, setClock: (d: Date) => (clock = d) };
}

/** Every assistant tool_use must be answered by a tool_result in the very next message, and roles must alternate. */
function assertValidHistory(req: ModelRequest) {
  const msgs = req.messages;
  expect(msgs[0]!.role).toBe("user");
  for (let i = 1; i < msgs.length; i++) expect(msgs[i]!.role).not.toBe(msgs[i - 1]!.role);
  msgs.forEach((m, i) => {
    if (m.role !== "assistant" || !Array.isArray(m.content)) return;
    expect(m.content.length).toBeGreaterThan(0);
    const ids = (m.content as { type: string; id?: string }[]).filter((b) => b.type === "tool_use").map((b) => b.id);
    if (!ids.length) return;
    const next = msgs[i + 1];
    const answered = Array.isArray(next?.content) ? (next!.content as { tool_use_id?: string }[]).map((b) => b.tool_use_id) : [];
    for (const id of ids) expect(answered).toContain(id);
  });
}

describe("webhook reliability", () => {
  it("a failed text doesn't lose the payment, and a crashed event is retried", async () => {
    const t = setup();
    await t.order();
    // Twilio is down when the payment lands.
    const realSend = t.sms.send.bind(t.sms);
    t.sms.send = async () => {
      throw new Error("Twilio 503");
    };
    await t.paid("SQORD1", "payment.updated", "evA");
    expect((await t.store.getOrderBySquareId("SQORD1"))!.status).toBe("paid");
    t.sms.send = realSend;

    // The store blows up mid-event: the claim is released so Square's retry runs it.
    const realGet = t.store.getOrderBySquareId.bind(t.store);
    t.store.getOrderBySquareId = async () => {
      throw new Error("db down");
    };
    const evt = { event_id: "evB", type: "order.fulfillment.updated", data: { object: { order_fulfillment_updated: { order_id: "SQORD1", fulfillment_update: [{ new_state: "PREPARED" }] } } } };
    await expect(t.service.handleSquareEvent(evt)).rejects.toThrow("db down");
    t.store.getOrderBySquareId = realGet;
    await t.service.handleSquareEvent(evt);
    expect(t.sms.last(CUSTOMER)).toMatch(/is ready/);
  });

  it("payment.created and payment.updated together send one Paid text", async () => {
    const t = setup();
    await t.order();
    await Promise.all([t.paid("SQORD1", "payment.created"), t.paid("SQORD1", "payment.updated")]);
    expect(t.sms.to(CUSTOMER).filter((m) => m.startsWith("Paid")).length).toBe(1);
  });

  it("if an old link gets paid, the newer one is cancelled so they can't pay twice", async () => {
    const t = setup();
    await t.order();
    await t.order(); // edit → link 2, link 1 replaced
    await t.paid("SQORD1"); // customer still had link 1 open
    expect(t.square.links.get("PL2")!.deleted).toBe(true);
    expect(t.sms.last(CUSTOMER)).toMatch(/earlier link.*cancelled the newer one \(#2\)/);
    expect(t.sms.last(OWNER)).toMatch(/paid after its link was replaced/);
    const statuses = Object.fromEntries((await t.store.listOrders(5)).map((o) => [o.orderNumber, o.status]));
    expect(statuses).toEqual({ 1: "paid", 2: "replaced" });
  });

  it("a ready event that beats the payment event still sends both texts", async () => {
    const t = setup();
    await t.order();
    await t.service.handleSquareEvent({ event_id: "r1", type: "order.fulfillment.updated", data: { object: { order_fulfillment_updated: { order_id: "SQORD1", fulfillment_update: [{ new_state: "PREPARED" }] } } } });
    expect(t.sms.to(CUSTOMER).slice(-2).map((m) => m.split("!")[0])).toEqual(["Paid, thanks", "Order #1 is ready"]);
  });
});

describe("links never outlive ordering", () => {
  it("PAUSE cancels unpaid links", async () => {
    const t = setup();
    await t.order();
    await t.text("PAUSE", OWNER);
    expect(t.square.links.get("PL1")!.deleted).toBe(true);
    expect(t.sms.last(CUSTOMER)).toMatch(/paused/);
    expect(t.sms.last(OWNER)).toMatch(/1 unpaid link cancelled/);
  });

  it("closing time cancels unpaid links on the next sweep", async () => {
    const t = setup({ ORDERING_HOURS: "tue=17:00-19:00" }); // 6:42pm Tue
    await t.order();
    t.setClock(new Date("2026-11-04T00:01:00Z")); // 7:01pm
    expect(await t.service.expireStaleLinks()).toBe(1);
    expect(t.square.links.get("PL1")!.deleted).toBe(true);
  });

  it("STOP cancels the unpaid link and nothing more is texted", async () => {
    const t = setup();
    await t.order();
    const before = t.sms.to(CUSTOMER).length;
    await t.text("STOP");
    expect(t.square.links.get("PL1")!.deleted).toBe(true);
    await t.paid("SQORD1"); // paid in the instant before deletion: honoured, but not texted
    expect((await t.store.getOrderBySquareId("SQORD1"))!.status).toBe("paid");
    expect(t.sms.to(CUSTOMER).length).toBe(before);
  });
});

describe("AI safety rails", () => {
  it("a reply cut off mid tool call doesn't break the next message", async () => {
    const t = setup();
    t.model.push(() => ({ content: [{ type: "tool_use", id: "cut1", name: "set_cart", input: {} }], stop_reason: "max_tokens" }));
    await t.text("big order...");
    t.model.push(() => ({ content: [], stop_reason: "end_turn" }));
    await t.text("hello?");
    t.model.push(say("Hi! What can I get you?"));
    await t.text("hello??");
    for (const r of t.model.requests) assertValidHistory(r);
    expect(t.sms.last(CUSTOMER)).toBe("Hi! What can I get you?");
  });

  it("history stays valid after hitting the tool-round limit", async () => {
    const t = setup();
    for (let i = 0; i < 8; i++) t.model.push(tool("order_status"));
    await t.text("where's my order");
    expect(t.sms.last(CUSTOMER)).toMatch(/got stuck/);
    t.model.push(say("Let's start fresh."));
    await t.text("ok");
    assertValidHistory(t.model.requests.at(-1)!);
  });

  it("an invented price is replaced with Square's own numbers", async () => {
    const t = setup();
    t.model.push(tool("set_cart", LINES), say("2 poutines, that'll be $18 plus tax, so about $20.00. Send the link?"));
    await t.text("2 poutines");
    const reply = t.sms.last(CUSTOMER);
    expect(reply).not.toContain("$20.00");
    expect(reply).toContain("Total $20.34");
    expect(reply).toMatch(/Want me to send the payment link/);
  });

  it("prices that came from the menu or Square are allowed through", async () => {
    const t = setup();
    t.model.push(tool("set_cart", LINES), say("2 poutines at $9.00 each, $20.34 with tax. Send the link?"));
    await t.text("2 poutines");
    expect(t.sms.last(CUSTOMER)).toBe("2 poutines at $9.00 each, $20.34 with tax. Send the link?");
  });

  it("reads dollar amounts", () => {
    expect(dollarAmounts("$5, $5.5, $ 12.34 and $1,200.00")).toEqual([500, 550, 1234, 120000]);
  });
});

describe("staff replies", () => {
  it("won't guess between two customers with the same last 4 digits", async () => {
    const t = setup();
    t.model.push(say("hi"), say("hi"));
    await t.text("hi", "+18075551234");
    await t.text("hi", "+12045551234");
    await t.text("TO 1234 hello", OWNER);
    expect(t.sms.last(OWNER)).toMatch(/More than one recent chat ends in 1234/);
    await t.text("TO 2045551234 hello", OWNER);
    expect(t.sms.last("+12045551234")).toBe("hello");
    expect(t.sms.to("+18075551234")).toEqual(["hi"]);
  });
});
