/*
 * Sandbox check (2026-11-03): CreateInvoice + PublishInvoice with store_payment_method_enabled worked and returned an
 * app.squareupsandbox.com/pay-invoice page. Square refuses CreatePayment against an order a published invoice owns
 * ("owned by another application"), so paying needs the invoice page itself. We handle both `payment.updated`
 * (payment with the invoice's order_id) and `invoice.payment_made`. Confirm on the live check which one arrives,
 * and that ticking "Save my card on file" shows up in ListCards afterwards.
 */
import { describe, expect, it } from "vitest";
import { TextOrderService } from "../src/service.js";
import { MemoryStore } from "../src/store/memory.js";
import { FakeSms, FakeSquare, ScriptedModel, say, testConfig, tool } from "./fakes.js";

const PHONE = "+18075551234";
const LINES = { lines: [{ variation_id: "V_POUTINE", quantity: 1 }] };
let sid = 0;

function setup(over: Record<string, string> = {}) {
  const store = new MemoryStore();
  const square = new FakeSquare();
  square.customers.push({ id: "C1", given_name: "Riley", phone_number: PHONE }); // known to Square, no saved card
  const sms = new FakeSms();
  const model = new ScriptedModel();
  let clock = new Date("2026-11-03T23:42:00Z");
  const service = new TextOrderService({ config: testConfig(over), store, square, sms, model, now: () => clock, log: () => {} });
  const text = (body: string) => service.handleInboundSms({ from: PHONE, body, messageSid: `SMi${++sid}` });
  const toolResult = (i: number) => JSON.stringify(model.requests[i]!.messages.at(-1));
  return { store, square, sms, model, service, text, toolResult, advance: (ms: number) => (clock = new Date(clock.getTime() + ms)) };
}

async function orderViaSavePage(t: ReturnType<typeof setup>) {
  t.model.push(tool("set_cart", LINES), say("A poutine. Want one-word ordering next time?"));
  await t.text("poutine");
  t.model.push(tool("send_card_save_page"), say("Here's your page."));
  await t.text("yes please");
}

describe("saving a card through Square's invoice page", () => {
  it("offers the save-card page once", async () => {
    const t = setup();
    t.model.push(tool("set_cart", LINES), say("ok"));
    await t.text("poutine");
    expect(t.toolResult(1)).toContain("save my card");
    expect((await t.store.getConversation(PHONE)).cardOfferMadeAt).not.toBeNull();
    t.model.push(tool("set_cart", LINES), say("ok"));
    await t.text("actually poutine again");
    expect(t.toolResult(3)).not.toContain("save my card");
  });

  it("isn't offered to a first-time number Square doesn't know", async () => {
    const t = setup();
    t.square.customers.length = 0;
    t.model.push(tool("set_cart", LINES), say("ok"));
    await t.text("poutine");
    expect(t.toolResult(1)).not.toContain("save my card");
  });

  it("save-card checkout sends a Square invoice page", async () => {
    const t = setup();
    await orderViaSavePage(t);
    const [inv] = [...t.square.invoices.values()];
    expect(inv).toMatchObject({ customerId: "C1", storeCard: true });
    const reply = t.sms.last(PHONE);
    expect(reply).toContain('Pay here, and tick "Save my card on file" for one-word ordering next time:');
    expect(reply).toContain(inv!.public_url!);
    expect(reply).toContain("Total $10.17");
    const order = (await t.store.listOrders(1))[0]!;
    expect(order).toMatchObject({ checkoutKind: "invoice", invoiceId: inv!.id, paymentLinkUrl: inv!.public_url, status: "awaiting_payment" });
    expect(t.square.calls).not.toContain("createPaymentLink");
  });

  it("paying the invoice marks the order paid and refreshes the card", async () => {
    const t = setup();
    await orderViaSavePage(t);
    const order = (await t.store.listOrders(1))[0]!;
    await t.service.handleSquareEvent({ event_id: "e1", type: "payment.updated", data: { object: { payment: { status: "COMPLETED", order_id: order.squareOrderId } } } });
    expect((await t.store.getOrderBySquareId(order.squareOrderId))!.status).toBe("paid");
    t.square.cards.set("C1", [{ id: "ccof:new", card_brand: "VISA", last_4: "4242", enabled: true }]);
    const before = t.square.calls.filter((c) => c === "listCards").length;
    t.model.push(say("hi again"));
    await t.text("hey");
    expect(t.square.calls.filter((c) => c === "listCards").length).toBe(before + 1);
    expect((await t.store.getConversation(PHONE)).savedCard).toMatchObject({ id: "ccof:new" });
  });

  it("invoice.payment_made also marks it paid", async () => {
    const t = setup();
    await orderViaSavePage(t);
    const order = (await t.store.listOrders(1))[0]!;
    await t.service.handleSquareEvent({ event_id: "e2", type: "invoice.payment_made", data: { object: { invoice: { id: order.invoiceId, order_id: order.squareOrderId } } } });
    expect((await t.store.getOrderBySquareId(order.squareOrderId))!.status).toBe("paid");
  });

  it("unpaid invoices expire like links", async () => {
    const t = setup();
    await orderViaSavePage(t);
    const order = (await t.store.listOrders(1))[0]!;
    t.advance(21 * 60_000);
    await t.service.expireStaleLinks();
    expect(t.square.calls).toContain(`cancelInvoice:${order.invoiceId}`);
    expect((await t.store.getOrderBySquareId(order.squareOrderId))!.status).toBe("expired");
  });

  it("a new link replaces an unpaid invoice", async () => {
    const t = setup();
    await orderViaSavePage(t);
    const order = (await t.store.listOrders(1))[0]!;
    t.model.push(tool("set_cart", LINES), tool("send_checkout_link"), say("link instead"));
    await t.text("just send a normal link");
    expect(t.square.calls).toContain(`cancelInvoice:${order.invoiceId}`);
    expect((await t.store.getOrderBySquareId(order.squareOrderId))!.status).toBe("replaced");
  });
});
