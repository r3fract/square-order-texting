import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseScorebar, type FeedGame } from "../src/game/hockeytech.js";
import { estimateTimeline } from "../src/game/timeline.js";
import { resolvePickup } from "../src/pickup.js";
import { TextOrderService } from "../src/service.js";
import { MemoryStore } from "../src/store/memory.js";
import { FakeSms, FakeSquare, ScriptedModel, say, testConfig, tool } from "./fakes.js";

const TZ = "Etc/GMT+5";
const fixture = JSON.parse(readFileSync(new URL("./fixtures/hockeytech-scorebar-2026-11-03.json", import.meta.url), "utf8"));
const base = parseScorebar(fixture).find((g) => g.id === "4011")!; // Sun Nov 8, 3:15pm local (20:15Z), Lakers home
const OPTS = { secondsPerClockMinute: 105, intermissionMinutes: 18, intermissionStartedAt: null };
const PRE = new Date("2026-11-08T19:00:00Z"); // 2pm local, before puck drop

function today(g: FeedGame = base, now = PRE) {
  return { game: g, timeline: estimateTimeline(g, now, OPTS) };
}

describe("resolvePickup", () => {
  it("right away", () => {
    expect(resolvePickup({ kind: "asap" }, null, false, PRE, TZ)).toEqual({ ok: true, pickupAt: null, slotKey: "asap", label: "right away" });
  });

  it("the 2nd intermission", () => {
    const r = resolvePickup({ kind: "intermission", n: 2 }, today(), true, PRE, TZ);
    expect(r).toEqual({ ok: true, pickupAt: new Date("2026-11-08T21:43:00Z"), slotKey: "game:4011:int2", label: "the 2nd intermission" });
  });

  it("the next intermission skips one that has started", () => {
    const g = { ...base, status: "in_progress" as const, period: 2, clockSeconds: 600 };
    const now = new Date("2026-11-08T21:20:00Z");
    const r = resolvePickup({ kind: "next_intermission" }, today(g, now), true, now, TZ);
    expect(r).toMatchObject({ ok: true, slotKey: "game:4011:int2", label: "the 2nd intermission" });
  });

  it("after the game", () => {
    const r = resolvePickup({ kind: "after_game" }, today(), true, PRE, TZ);
    expect(r).toEqual({ ok: true, pickupAt: new Date("2026-11-08T22:36:00Z"), slotKey: "game:4011:end", label: "after the game" });
  });

  it("a clock time later today", () => {
    expect(resolvePickup({ kind: "clock", hhmm: "15:30" }, null, false, PRE, TZ)).toEqual({
      ok: true, pickupAt: new Date("2026-11-08T20:30:00Z"), slotKey: "clock", label: "about 3:30",
    });
  });

  it("a clock time that already passed is refused", () => {
    expect(resolvePickup({ kind: "clock", hhmm: "13:00" }, null, false, PRE, TZ)).toEqual({ ok: false, reason: "That time has already passed. Want it right away?" });
  });

  it("game words with no home game today", () => {
    expect(resolvePickup({ kind: "intermission", n: 2 }, null, false, PRE, TZ)).toEqual({ ok: false, reason: "There's no Lakers home game today." });
  });

  it("game words when the feed can't be trusted", () => {
    expect(resolvePickup({ kind: "intermission", n: 1 }, today(), false, PRE, TZ)).toEqual({
      ok: false, reason: "I can't see the game clock right now, so I can do right away or a time like 8:15.",
    });
  });

  it("an intermission that already started", () => {
    const g = { ...base, status: "intermission" as const, period: 2, clockSeconds: 0 };
    const now = new Date("2026-11-08T21:50:00Z");
    expect(resolvePickup({ kind: "intermission", n: 2 }, today(g, now), true, now, TZ)).toEqual({
      ok: false, reason: "The 2nd intermission has already started. Want it right away instead?",
    });
  });
});

/* ---------------- full flows ---------------- */

const PHONE = "+18075551234";
let sid = 0;
function setup(over: Record<string, string> = {}, now = PRE) {
  const store = new MemoryStore();
  const square = new FakeSquare();
  const sms = new FakeSms();
  const model = new ScriptedModel();
  let clock = now;
  let games = parseScorebar(fixture);
  const service = new TextOrderService({
    config: testConfig({ TIMEZONE: TZ, HOCKEYTECH_TEAM_ID: "9", ...over }),
    store, square, sms, model, now: () => clock, log: () => {}, fetchGames: async () => games,
  });
  const text = (body: string, from = PHONE) => service.handleInboundSms({ from, body, messageSid: `SMp${++sid}` });
  const pay = (orderId: string) =>
    service.handleSquareEvent({ event_id: `ev${++sid}`, type: "payment.updated", data: { object: { payment: { status: "COMPLETED", order_id: orderId } } } });
  return { store, square, sms, model, service, text, pay, setClock: (d: Date) => (clock = d), setGames: (g: FeedGame[]) => (games = g) };
}
const LINES = { lines: [{ variation_id: "V_POUTINE", quantity: 1 }] };

describe("ordering for an intermission", () => {
  it("orders for the 2nd intermission land on the kitchen screen at the right time", async () => {
    const t = setup();
    await t.service.game!.tick();
    t.model.push(tool("set_cart", LINES), tool("set_pickup_time", { target: "intermission_2" }), tool("send_checkout_link"), say("Here you go."));
    await t.text("poutine for the end of the 2nd");
    expect(JSON.stringify(t.model.requests[2]!.messages.at(-1))).toContain("Pickup set for the 2nd intermission, ready about 4:43.");
    expect(t.model.requests[0]!.system).toContain("Lakers vs DID 3:15pm");
    expect(t.model.requests[0]!.system).toContain("call set_pickup_time. Never work out times yourself.");

    const link = t.square.links.get("PL1")!;
    expect(link.order.fulfillments?.[0]).toMatchObject({
      pickup_details: { schedule_type: "SCHEDULED", pickup_at: "2026-11-08T21:43:00.000Z", prep_time_duration: "PT8M", note: "Text order #1 · the 2nd intermission" },
    });
    const rec = (await t.store.getOrderBySquareId("SQORD1"))!;
    expect(rec).toMatchObject({ pickupSlot: "game:4011:int2", pickupAt: new Date("2026-11-08T21:43:00Z"), quotedReadyAt: new Date("2026-11-08T21:43:00Z") });

    await t.pay("SQORD1");
    expect(t.sms.last(PHONE)).toBe("Paid, thanks! Order #1. You're 1st for the 2nd intermission, ready about 4:43. We'll text you when it's ready.");
  });

  it("the second order in an intermission is told it's 2nd", async () => {
    const t = setup();
    await t.service.game!.tick();
    for (const phone of ["+18075550001", "+18075550002"]) {
      t.model.push(tool("set_cart", LINES), tool("set_pickup_time", { target: "intermission_2" }), tool("send_checkout_link"), say("ok"));
      await t.text("poutine end of 2nd", phone);
      await t.pay((await t.store.getAwaitingOrderForPhone(phone))!.squareOrderId);
    }
    expect(t.sms.last("+18075550002")).toContain("You're 2nd for the 2nd intermission");
  });

  it("a full intermission offers the next slot", async () => {
    const t = setup({ INTERMISSION_CAPACITY: "1" });
    await t.service.game!.tick();
    t.model.push(tool("set_cart", LINES), tool("set_pickup_time", { target: "intermission_2" }), tool("send_checkout_link"), say("ok"));
    await t.text("poutine end of 2nd", "+18075550001");
    await t.pay("SQORD1");
    t.model.push(tool("set_cart", LINES), tool("set_pickup_time", { target: "intermission_2" }), tool("send_checkout_link"), say("full"));
    await t.text("poutine end of 2nd", "+18075550002");
    expect(JSON.stringify(t.model.requests.at(-1)!.messages.at(-1))).toContain("The 2nd intermission is full. Want the next one, or right away?");
    expect(t.square.links.size).toBe(1);
  });

  it("pre-orders don't block ASAP orders", async () => {
    const t = setup({ MAX_ACTIVE_ORDERS: "1" });
    await t.service.game!.tick();
    t.model.push(tool("set_cart", LINES), tool("set_pickup_time", { target: "intermission_2" }), tool("send_checkout_link"), say("ok"));
    await t.text("poutine end of 2nd", "+18075550001");
    await t.pay("SQORD1");
    t.model.push(tool("set_cart", LINES), tool("send_checkout_link"), say("now"));
    await t.text("poutine now", "+18075550002");
    expect(t.square.links.size).toBe(2);
  });

  it("the next order after a paid one starts back at right away", async () => {
    const t = setup();
    await t.service.game!.tick();
    t.model.push(tool("set_cart", LINES), tool("set_pickup_time", { target: "intermission_2" }), tool("send_checkout_link"), say("ok"));
    await t.text("poutine end of 2nd");
    await t.pay("SQORD1");
    t.model.push(tool("set_cart", LINES), tool("send_checkout_link"), say("again"));
    await t.text("another poutine");
    expect((await t.store.getAwaitingOrderForPhone(PHONE))!.pickupSlot).toBe("asap");
  });

  it("a slower 2nd period moves the order in Square and tells the customer", async () => {
    const t = setup();
    await t.service.game!.tick();
    t.model.push(tool("set_cart", LINES), tool("set_pickup_time", { target: "intermission_2" }), tool("send_checkout_link"), say("ok"));
    await t.text("poutine end of 2nd");
    await t.pay("SQORD1");

    const liveGames = parseScorebar(fixture).map((g) => (g.id === "4011" ? { ...g, status: "in_progress" as const, period: 2, clockSeconds: 15 * 60 } : g));
    t.setGames(liveGames);
    t.setClock(new Date("2026-11-08T21:30:00Z")); // 4:30pm; 15:00 left × 105 s ≈ 4:56:15
    await t.service.game!.tick();

    expect(t.square.orders.get("SQORD1")!.pickupAt).toBe("2026-11-08T21:56:15.000Z");
    expect(t.sms.last(PHONE)).toBe("Heads up: the 2nd period is running long. Order #1 will be ready about 4:56.");
  });

  it("ASAP paid text says the place in line", async () => {
    const t = setup();
    t.model.push(tool("set_cart", LINES), tool("send_checkout_link"), say("ok"));
    await t.text("poutine now");
    await t.pay("SQORD1");
    expect(t.sms.last(PHONE)).toBe("Paid, thanks! Order #1. You're 1st in line. We'll text you when it's ready.");
  });

  it("game words with the feed off get the fallback, and no link", async () => {
    const t = setup({}, PRE);
    t.service.game!; // never ticked: no game known
    t.model.push(tool("set_cart", LINES), tool("set_pickup_time", { target: "intermission_1" }), say("No game"));
    await t.text("poutine end of 1st");
    expect(JSON.stringify(t.model.requests.at(-1)!.messages.at(-1))).toContain("There's no Lakers home game today.");
  });
});
