import { describe, expect, it } from "vitest";
import type { Timeline } from "../src/game/timeline.js";
import { reconcileSchedule } from "../src/schedule.js";
import { SquareError } from "../src/square/client.js";
import { MemoryStore } from "../src/store/memory.js";
import { FakeSquare, orderFixture } from "./fakes.js";

const TZ = "Etc/GMT+5";
const T = new Date("2026-11-08T21:43:00Z"); // quoted 2nd intermission: 4:43 local
const min = (n: number) => n * 60_000;
const tl = (int2: Date, trustworthy = true): Timeline => ({ gameId: "4011", intermissionStarts: { 1: null, 2: int2 }, gameEnd: new Date(int2.getTime() + min(53)), trustworthy });

async function setup() {
  const store = new MemoryStore();
  const square = new FakeSquare();
  const sq = await square.createOrder({ idempotencyKey: "k", order: { location_id: "LOC1", line_items: [], fulfillments: [{ pickup_details: { pickup_at: T.toISOString() } }] } });
  const order = orderFixture({ phone: "+18075551234", orderNumber: 12, squareOrderId: sq.id!, pickupSlot: "game:4011:int2", pickupAt: T, quotedReadyAt: T, status: "paid" });
  await store.createOrder(order);
  const texts: { to: string; body: string }[] = [];
  const owner: string[] = [];
  const deps = {
    square, store, now: () => new Date("2026-11-08T21:00:00Z"), tz: TZ,
    sendCustomer: async (to: string, body: string) => (texts.push({ to, body }), true),
    notifyOwner: async (t: string) => void owner.push(t),
    alerted: new Set<string>(),
  };
  const saved = async () => (await store.getOrderBySquareId(sq.id!))!;
  return { store, square, deps, texts, owner, saved, squareId: sq.id! };
}

describe("keeping scheduled orders in step with the game", () => {
  it("a 2-minute shift changes nothing", async () => {
    const t = await setup();
    await reconcileSchedule(t.deps, null, tl(new Date(T.getTime() + min(2))));
    expect(t.square.calls.filter((c) => c.startsWith("updatePickupAt"))).toHaveLength(0);
    expect(t.texts).toHaveLength(0);
  });

  it("a 4-minute shift moves Square but doesn't text", async () => {
    const t = await setup();
    const later = new Date(T.getTime() + min(4));
    await reconcileSchedule(t.deps, null, tl(later));
    expect(t.square.orders.get(t.squareId)!.pickupAt).toBe(later.toISOString());
    expect((await t.saved()).pickupAt).toEqual(later);
    expect(t.texts).toHaveLength(0);
  });

  it("a 6-minute shift texts the customer once", async () => {
    const t = await setup();
    await reconcileSchedule(t.deps, null, tl(new Date(T.getTime() + min(6))));
    expect(t.texts).toEqual([{ to: "+18075551234", body: "Heads up: the 2nd period is running long. Order #12 will be ready about 4:49." }]);
    expect((await t.saved()).etaNotifiedAt).not.toBeNull();
    expect((await t.saved()).quotedReadyAt).toEqual(new Date(T.getTime() + min(6)));
    await reconcileSchedule(t.deps, null, tl(new Date(T.getTime() + min(12))));
    expect(t.texts).toHaveLength(1);
    expect(t.square.orders.get(t.squareId)!.pickupAt).toBe(new Date(T.getTime() + min(12)).toISOString());
  });

  it("an earlier intermission says it's running short", async () => {
    const t = await setup();
    await reconcileSchedule(t.deps, null, tl(new Date(T.getTime() - min(7))));
    expect(t.texts[0]!.body).toBe("Heads up: the 2nd period is running short. Order #12 will be ready about 4:36.");
  });

  it("Square refusing an edit alerts the owner and warns the customer once", async () => {
    const t = await setup();
    t.square.failNext.updatePickupAt = new SquareError("nope", 400);
    await reconcileSchedule(t.deps, null, tl(new Date(T.getTime() + min(8))));
    expect(t.owner).toEqual(["⚠️ Couldn't move order #12 to 4:51 in Square. It may be ready early."]);
    expect(t.texts).toEqual([{ to: "+18075551234", body: "Heads up: order #12 may be ready a little before 4:43." }]);
    expect((await t.saved()).pickupAt).toEqual(T);
  });

  it("a stuck order alerts the owner once, not every poll", async () => {
    const t = await setup();
    for (const m of [8, 9, 10]) {
      t.square.failNext.updatePickupAt = new SquareError("nope", 400);
      await reconcileSchedule(t.deps, null, tl(new Date(T.getTime() + min(m))));
    }
    expect(t.owner).toHaveLength(1);
    expect(t.texts).toHaveLength(1);
  });

  it("untrustworthy timeline leaves orders alone", async () => {
    const t = await setup();
    await reconcileSchedule(t.deps, null, tl(new Date(T.getTime() + min(20)), false));
    expect(t.square.calls.filter((c) => c.startsWith("updatePickupAt"))).toHaveLength(0);
    expect(t.texts).toHaveLength(0);
  });

  it("orders from another game or already ready are left alone", async () => {
    const t = await setup();
    await t.store.updateOrder((await t.saved()).id, { status: "ready" });
    await reconcileSchedule(t.deps, null, tl(new Date(T.getTime() + min(10))));
    expect(t.square.calls.filter((c) => c.startsWith("updatePickupAt"))).toHaveLength(0);
  });
});
