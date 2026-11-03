import { describe, expect, it } from "vitest";
import { TextOrderService } from "../src/service.js";
import { SquareError } from "../src/square/client.js";
import { MemoryStore } from "../src/store/memory.js";
import { FakeSms, FakeSquare, ScriptedModel, say, testConfig, tool } from "./fakes.js";

const PHONE = "+18075551234";
const LINES = { lines: [{ variation_id: "V_POUTINE", quantity: 1 }] }; // $9.00 + 13% = $10.17
let sid = 0;

function setup(over: Record<string, string> = {}, card = "ccof:1") {
  const store = new MemoryStore();
  const square = new FakeSquare();
  square.customers.push({ id: "C1", given_name: "Riley", phone_number: PHONE });
  square.cards.set("C1", [{ id: card, card_brand: "VISA", last_4: "1111", enabled: true }]);
  const sms = new FakeSms();
  const model = new ScriptedModel();
  let clock = new Date("2026-11-03T23:42:00Z");
  const service = new TextOrderService({ config: testConfig(over), store, square, sms, model, now: () => clock, log: () => {} });
  const text = (body: string) => service.handleInboundSms({ from: PHONE, body, messageSid: `SMo${++sid}` });
  const lastToolResult = () => JSON.stringify(model.requests.at(-1)!.messages.at(-1));
  return { store, square, sms, model, service, text, lastToolResult, advance: (ms: number) => (clock = new Date(clock.getTime() + ms)) };
}

/** Customer orders; the bot offers one-word pay. */
async function offer(t: ReturnType<typeof setup>) {
  t.model.push(tool("set_cart", LINES), say("A poutine, $10.17. Pay with VISA ••1111? Reply Y."));
  await t.text("a poutine please");
}

describe("one-word pay with a saved card", () => {
  it("set_cart offers one-word pay to a customer with a saved card", async () => {
    const t = setup();
    await offer(t);
    expect(JSON.stringify(t.model.requests[1]!.messages.at(-1))).toContain('end your read-back with \\"Pay with VISA ••1111? Reply Y.\\"');
    expect(t.model.requests[0]!.system).toContain("call pay_with_saved_card");
    const conv = await t.store.getConversation(PHONE);
    expect(conv.pendingOneTap).toMatchObject({ totalCents: 1017 });
  });

  it("Y pays with the saved card, no link", async () => {
    const t = setup();
    await offer(t);
    t.model.push(tool("pay_with_saved_card"), say("Done!"));
    await t.text("Y");
    expect(t.square.payments).toHaveLength(1);
    expect(t.square.payments[0]).toMatchObject({ source_id: "ccof:1", amount: 1017, customer_id: "C1" });
    expect(t.square.calls).not.toContain("createPaymentLink");
    const texts = t.sms.to(PHONE);
    expect(texts.at(-2)).toContain("Done!");
    expect(texts.at(-2)).toContain("Total $10.17");
    expect(texts.at(-2)).toContain("Charged to VISA ••1111.");
    expect(texts.at(-1)).toBe("Paid, thanks! Order #1. You're 1st in line. We'll text you when it's ready.");
    const order = (await t.store.listOrders(5))[0]!;
    expect(order).toMatchObject({ checkoutKind: "card_on_file", status: "paid", paymentLinkUrl: null });
    expect(order.squarePaymentId).toBeTruthy();
    expect((await t.store.getConversation(PHONE)).pendingOneTap).toBeNull();
  });

  it("double Y charges once", async () => {
    const t = setup();
    await offer(t);
    t.model.push(tool("pay_with_saved_card"), say("Done!"), tool("pay_with_saved_card"), say("Already done."));
    await t.text("Y");
    await t.text("Y");
    expect(t.square.payments).toHaveLength(1);
    expect(t.lastToolResult()).toContain("That order is already paid.");
  });

  it("Y after changing the cart doesn't charge", async () => {
    const t = setup();
    await offer(t);
    const conv = await t.store.getConversation(PHONE);
    conv.cart = [{ variationId: "V_POUTINE", quantity: 3, modifierIds: [] }];
    await t.store.saveConversation(conv);
    t.model.push(tool("pay_with_saved_card"), say("Let me re-check."));
    await t.text("Y");
    expect(t.square.payments).toHaveLength(0);
    expect(t.lastToolResult()).toContain("The order changed since the offer");
  });

  it("Y after 10 minutes doesn't charge", async () => {
    const t = setup();
    await offer(t);
    t.advance(11 * 60_000);
    t.model.push(tool("pay_with_saved_card"), say("Expired."));
    await t.text("Y");
    expect(t.square.payments).toHaveLength(0);
    expect(t.lastToolResult()).toContain("That offer expired");
  });

  it("Y with no offer doesn't charge", async () => {
    const t = setup();
    t.model.push(tool("pay_with_saved_card"), say("Hmm."));
    await t.text("Y");
    expect(t.square.payments).toHaveLength(0);
    expect(t.lastToolResult()).toContain("There's no one-word pay offer open");
  });

  it("over the cap gets a link instead", async () => {
    const t = setup({ ONE_TAP_MAX_CENTS: "500" });
    await offer(t);
    expect(JSON.stringify(t.model.requests[1]!.messages.at(-1))).not.toContain("one-word pay");
    expect((await t.store.getConversation(PHONE)).pendingOneTap).toBeNull();
    t.model.push(tool("pay_with_saved_card"), say("Hmm."));
    await t.text("Y");
    expect(t.square.payments).toHaveLength(0);
  });

  it("a declined card falls back to a link", async () => {
    const t = setup({}, "ccof:decline");
    await offer(t);
    t.model.push(tool("pay_with_saved_card"), say("Sorry about that."));
    await t.text("Y");
    const reply = t.sms.last(PHONE);
    expect(reply.startsWith("That card didn't go through, so here's a secure link instead.")).toBe(true);
    expect(reply).toContain("https://square.link/u/");
    expect(t.square.payments).toHaveLength(0);
  });

  it("a Square decline error also falls back to a link", async () => {
    const t = setup();
    await offer(t);
    t.square.failNext.createPayment = new SquareError("declined", 402, [{ code: "CARD_DECLINED" }]);
    t.model.push(tool("pay_with_saved_card"), say("Sorry."));
    await t.text("Y");
    expect(t.sms.last(PHONE)).toContain("https://square.link/u/");
  });

  it("a total that changed at Square re-offers instead of charging", async () => {
    const t = setup();
    await offer(t);
    const conv = await t.store.getConversation(PHONE);
    conv.pendingOneTap = { ...conv.pendingOneTap!, totalCents: 999 }; // what we offered no longer matches Square
    await t.store.saveConversation(conv);
    t.model.push(tool("pay_with_saved_card"), say("New total."));
    await t.text("Y");
    expect(t.square.payments).toHaveLength(0);
    expect(t.lastToolResult()).toContain("The total is now $10.17");
    expect((await t.store.getConversation(PHONE)).pendingOneTap).toMatchObject({ totalCents: 1017 });
  });

  it("forget my card", async () => {
    const t = setup();
    t.model.push(say("hi"));
    await t.text("hi");
    t.model.push(tool("forget_saved_card"), say("Done."));
    await t.text("forget my card");
    expect(t.square.calls).toContain("disableCard:ccof:1");
    expect(t.lastToolResult()).toContain("Card removed. You'll get a payment link from now on.");
    expect((await t.store.getConversation(PHONE)).savedCard).toBeNull();
  });

  it("the AI can't pay in the same turn it made the offer", async () => {
    const t = setup();
    t.model.push(tool("set_cart", LINES), tool("pay_with_saved_card"), say("Paid?"));
    await t.text("a poutine please");
    expect(t.square.payments).toHaveLength(0);
    expect(t.lastToolResult()).toContain("Wait for them to reply Y");
  });

  it("only a plain yes pays, whatever the AI decides", async () => {
    const t = setup();
    await offer(t);
    t.model.push(tool("pay_with_saved_card"), say("Paid?"));
    await t.text("hmm what about fries too");
    expect(t.square.payments).toHaveLength(0);
    expect(t.lastToolResult()).toContain("Wait for them to reply Y");
    t.model.push(tool("pay_with_saved_card"), say("Done"));
    await t.text("Yep!");
    expect(t.square.payments).toHaveLength(1);
  });

  it("a card removed in Square after the offer isn't charged", async () => {
    const t = setup();
    await offer(t);
    t.square.cards.get("C1")![0]!.enabled = false;
    t.model.push(tool("pay_with_saved_card"), say("Hmm"));
    await t.text("Y");
    expect(t.square.payments).toHaveLength(0);
    expect(t.lastToolResult()).toContain("The saved card isn't available anymore");
  });

  it("an unclear Square error doesn't send a link (no double charge)", async () => {
    const t = setup();
    await offer(t);
    t.square.failNext.createPayment = new SquareError("Square hiccup", 500, [{ code: "INTERNAL_SERVER_ERROR" }]);
    t.model.push(tool("pay_with_saved_card"), say("Checking."));
    await t.text("Y");
    expect(t.square.calls).not.toContain("createPaymentLink");
    expect(t.lastToolResult()).toContain("couldn't confirm that payment with Square yet");
    const order = (await t.store.listOrders(1))[0]!;
    expect(order).toMatchObject({ checkoutKind: "card_on_file", status: "awaiting_payment" });
  });

  it("a daily cap per phone stops one-word pay", async () => {
    const t = setup({ ONE_TAP_DAILY_MAX_CENTS: "1500" });
    await offer(t);
    t.model.push(tool("pay_with_saved_card"), say("Done"));
    await t.text("Y");
    expect(t.square.payments).toHaveLength(1);
    await offer(t); // second $10.17 order would make $20.34 today
    expect((await t.store.getConversation(PHONE)).pendingOneTap).toBeNull();
  });

  it("two profiles on one phone never get one-word pay", async () => {
    const t = setup();
    t.square.customers.push({ id: "C2", given_name: "Other", phone_number: PHONE });
    await offer(t);
    expect((await t.store.getConversation(PHONE)).pendingOneTap).toBeNull();
  });
});
