import { describe, expect, it } from "vitest";
import { TextOrderService } from "../src/service.js";
import { MemoryStore } from "../src/store/memory.js";
import { FakeSms, FakeSquare, ScriptedModel, say, testConfig, tool } from "./fakes.js";

const PHONE = "+18075551234";
const ORDER = { lines: [{ variation_id: "V_POUTINE", quantity: 2 }, { variation_id: "V_FRIES_L", quantity: 1 }] };
let sid = 0;

function setup(opts: { member?: boolean; card?: boolean } = {}) {
  const store = new MemoryStore();
  const square = new FakeSquare();
  square.customers.push({ id: "C1", given_name: "Riley", phone_number: PHONE });
  if (opts.card) square.cards.set("C1", [{ id: "ccof:1", card_brand: "VISA", last_4: "1111", enabled: true }]);
  square.loyalty.program = { id: "LP1", reward_tiers: [{ id: "T1", name: "Free poutine", points: 10 }] };
  if (opts.member) square.loyalty.accounts.set("C1", { id: "LA1", balance: 12 });
  const sms = new FakeSms();
  const model = new ScriptedModel();
  let clock = new Date("2026-11-03T23:42:00Z");
  const service = new TextOrderService({ config: testConfig(), store, square, sms, model, now: () => clock, log: () => {} });
  const text = (body: string) => service.handleInboundSms({ from: PHONE, body, messageSid: `SMk${++sid}` });
  const event = (type: string, object: unknown) => service.handleSquareEvent({ event_id: `ek${++sid}`, type, data: { object } });
  const lastToolResult = () => JSON.stringify(model.requests.at(-1)!.messages.at(-1));
  return { store, square, sms, model, service, text, event, lastToolResult, advance: (ms: number) => (clock = new Date(clock.getTime() + ms)) };
}

async function paidLinkOrder(t: ReturnType<typeof setup>) {
  t.model.push(tool("set_cart", ORDER), tool("send_checkout_link"), say("ok"));
  await t.text("2 poutines and large fries, send it");
  const o = (await t.store.getAwaitingOrderForPhone(PHONE))!;
  await t.event("payment.updated", { payment: { status: "COMPLETED", order_id: o.squareOrderId } });
  return o;
}

describe("the usual", () => {
  it("reorders the last paid cart", async () => {
    const t = setup();
    const first = await paidLinkOrder(t);
    t.advance(7 * 60 * 60 * 1000); // a new chat
    t.model.push(tool("reorder_last"), say("Same as last time?"));
    await t.text("the usual");
    const conv = await t.store.getConversation(PHONE);
    expect(conv.cart).toEqual(first.cart);
    expect(t.lastToolResult()).toContain("Total $27.12");
  });

  it("flags sold-out items instead of dropping them", async () => {
    const t = setup();
    await paidLinkOrder(t);
    t.square.stock.set("V_POUTINE", 0);
    t.square.catalog = t.square.catalog.map((o) =>
      o.id === "IT_POUTINE" ? { ...o, item_data: { ...o.item_data, variations: o.item_data!.variations!.map((v) => ({ ...v, item_variation_data: { ...v.item_variation_data, track_inventory: true } })) } } : o,
    );
    await t.service.menus.getMenu(true); // pick up the catalog change, as the periodic refresh would
    t.model.push(tool("reorder_last"), say("Poutine's out."));
    await t.text("same as last time");
    expect(t.lastToolResult()).toMatch(/sold out/i);
    expect((await t.store.getConversation(PHONE)).cart).toHaveLength(2);
  });

  it("with no earlier order", async () => {
    const t = setup();
    t.model.push(tool("reorder_last"), say("Nothing yet."));
    await t.text("the usual");
    expect(t.lastToolResult()).toContain("No earlier order found.");
  });
});

describe("Square Loyalty", () => {
  it("tells the AI the balance and the reward they can afford", async () => {
    const t = setup({ member: true });
    t.model.push(say("hi"));
    await t.text("hi");
    const sys = t.model.requests[0]!.system;
    expect(sys).toContain("Loyalty: 12 points; can redeem: Free poutine (tier T1)");
    expect(sys).toContain("Mention an available reward once per chat.");
  });

  it("points are added at pickup, not payment", async () => {
    const t = setup({ member: true });
    t.model.push(say("hi"));
    await t.text("hi");
    const o = await paidLinkOrder(t);
    expect(t.square.accumulated).toHaveLength(0);
    await t.event("order.fulfillment.updated", { order_fulfillment_updated: { order_id: o.squareOrderId, fulfillment_update: [{ new_state: "COMPLETED" }] } });
    expect(t.square.accumulated).toEqual([{ accountId: "LA1", orderId: o.squareOrderId, locationId: "LOC1", idempotencyKey: `loyalty:${o.id}` }]);
  });

  it("non-members are never enrolled", async () => {
    const t = setup();
    const o = await paidLinkOrder(t);
    await t.event("order.fulfillment.updated", { order_fulfillment_updated: { order_id: o.squareOrderId, fulfillment_update: [{ new_state: "COMPLETED" }] } });
    expect(t.square.accumulated).toHaveLength(0);
    expect(t.square.calls.filter((c) => /loyalty/i.test(c) && c !== "searchLoyaltyAccount" && c !== "retrieveLoyaltyProgram")).toEqual([]);
  });

  it("a reward that changes the total re-offers instead of charging", async () => {
    const t = setup({ member: true, card: true });
    t.square.rewardDiscountCents = 400;
    t.model.push(tool("redeem_reward", { tier_id: "T1" }), tool("set_cart", ORDER), say("With your free poutine... Pay with VISA ••1111? Reply Y."));
    await t.text("use my reward, 2 poutines and large fries");
    t.model.push(tool("pay_with_saved_card"), say("New total."));
    await t.text("Y");
    expect(t.square.payments).toHaveLength(0);
    expect(t.lastToolResult()).toContain("The total is now $23.12");
    t.model.push(tool("pay_with_saved_card"), say("Done"));
    await t.text("Y");
    expect(t.square.payments).toHaveLength(1);
    expect(t.square.payments[0]!.amount).toBe(2312);
    expect(t.square.rewards).toHaveLength(1);
    expect((await t.store.getConversation(PHONE)).pendingRewardTierId).toBeNull();
  });

  it("a declined card releases the reward before falling back to a link", async () => {
    const t = setup({ member: true, card: true });
    t.square.cards.set("C1", [{ id: "ccof:decline", card_brand: "VISA", last_4: "1111", enabled: true }]);
    t.model.push(tool("redeem_reward", { tier_id: "T1" }), tool("set_cart", ORDER), say("Pay with VISA ••1111? Reply Y."));
    await t.text("use my reward, 2 poutines and large fries");
    t.model.push(tool("pay_with_saved_card"), say("Sorry."));
    await t.text("Y");
    expect(t.square.calls.filter((c) => c.startsWith("deleteLoyaltyReward"))).toHaveLength(t.square.rewards.length);
    expect(t.sms.last(PHONE)).toContain("https://square.link/u/");
    expect((await t.store.getConversation(PHONE)).pendingRewardTierId).toBeNull();
  });

  it("an expired save-card page releases its reward", async () => {
    const t = setup({ member: true });
    t.model.push(tool("redeem_reward", { tier_id: "T1" }), tool("set_cart", ORDER), tool("send_card_save_page"), say("page"));
    await t.text("use my reward, send the save-card page");
    expect(t.square.rewards).toHaveLength(1);
    t.advance(21 * 60_000);
    await t.service.expireStaleLinks();
    expect(t.square.calls.filter((c) => c.startsWith("deleteLoyaltyReward"))).toHaveLength(1);
  });

  it("rewards aren't redeemed on a plain payment link", async () => {
    const t = setup({ member: true });
    t.model.push(tool("redeem_reward", { tier_id: "T1" }), tool("set_cart", ORDER), tool("send_checkout_link"), say("hmm"));
    await t.text("use my reward and send a link");
    expect(t.lastToolResult()).toContain("Rewards work with a saved card or the save-card page.");
    expect(t.square.links.size).toBe(0);
  });

  it("can't redeem a tier they can't afford", async () => {
    const t = setup({ member: true });
    t.square.loyalty.accounts.set("C1", { id: "LA1", balance: 3 });
    t.model.push(tool("redeem_reward", { tier_id: "T1" }), say("Not yet."));
    await t.text("use my reward");
    expect(t.lastToolResult()).toContain("That reward isn't available");
  });
});
