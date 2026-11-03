import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryStore } from "../src/store/memory.js";
import { PostgresStore } from "../src/store/postgres.js";
import type { Store } from "../src/store/types.js";
import { orderFixture } from "./fakes.js";

const url = process.env.TEST_DATABASE_URL;
let seq = 0;
const uniq = () => `${Date.now()}${++seq}${Math.floor(Math.random() * 1e6)}`;


function storeSuite(name: string, make: () => Promise<Store>, done?: (s: Store) => Promise<void>) {
  describe(name, () => {
    let store: Store;
    beforeAll(async () => {
      store = await make();
    });
    afterAll(async () => {
      if (done) await done(store);
    });

    it("round-trips the new conversation and order fields", async () => {
      const phone = `+1807${uniq().slice(-7)}`;
      const conv = await store.getConversation(phone);
      expect(conv).toMatchObject({
        squareCustomerId: null, customerAmbiguous: false, customerLookupAt: null, savedCard: null,
        pendingOneTap: null, cardOfferMadeAt: null, pickupTarget: null, loyaltyAccountId: null,
      });
      conv.squareCustomerId = "CUST1";
      conv.customerAmbiguous = true;
      conv.customerLookupAt = new Date("2026-11-03T20:00:00Z");
      conv.savedCard = { id: "ccof:1", brand: "VISA", last4: "1111" };
      conv.savedCards = [conv.savedCard, { id: "ccof:2", brand: "VISA", last4: "5858", otherIds: ["ccof:3"] }];
      conv.pendingOneTap = { cartHash: "abc", totalCents: 875, offeredAt: new Date("2026-11-03T20:01:00Z") };
      conv.cardOfferMadeAt = new Date("2026-11-03T20:02:00Z");
      conv.pickupTarget = { kind: "intermission", n: 2 };
      conv.loyaltyAccountId = "LA1";
      conv.loyaltyBalance = 12;
      conv.pendingRewardTierId = "T1";
      conv.updatedAt = new Date("2026-11-03T20:03:00Z");
      await store.saveConversation(conv);
      expect(await store.getConversation(phone)).toEqual(conv);

      const o = orderFixture({ phone, pickupAt: new Date("2026-11-03T21:00:00Z"), quotedReadyAt: new Date("2026-11-03T21:00:00Z"), etaNotifiedAt: new Date("2026-11-03T20:30:00Z"), invoiceId: "inv:1", invoiceVersion: 2 });
      await store.createOrder(o);
      expect(await store.getOrderBySquareId(o.squareOrderId)).toEqual(o);
    });

    it("counts orders per slot and finds the last paid order", async () => {
      const phone = `+1807${uniq().slice(-7)}`;
      const slot = `game:${uniq()}:int2`;
      await store.createOrder(orderFixture({ phone, pickupSlot: slot, status: "paid" }));
      await store.createOrder(orderFixture({ phone, pickupSlot: slot, status: "awaiting_payment" }));
      await store.createOrder(orderFixture({ phone, pickupSlot: slot, status: "expired" }));
      expect(await store.countOrdersInSlot(slot)).toBe(2);
      expect((await store.listOrdersInSlotPrefix(slot.replace(/int2$/, ""))).length).toBe(3);

      const older = orderFixture({ phone, status: "picked_up", createdAt: new Date("2026-11-01T20:00:00Z") });
      const newer = orderFixture({ phone, status: "ready", createdAt: new Date("2026-11-04T20:00:00Z") });
      const expired = orderFixture({ phone, status: "expired", createdAt: new Date("2026-11-05T20:00:00Z") });
      for (const x of [older, newer, expired]) await store.createOrder(x);
      expect((await store.lastPaidOrderForPhone(phone))?.id).toBe(newer.id);
      expect(await store.lastPaidOrderForPhone("+19999999999")).toBeNull();
    });

    it("lists one phone's card orders since a time, however many other orders exist", async () => {
      const phone = `+1807${uniq().slice(-7)}`;
      const since = new Date("2026-11-03T00:00:00Z");
      for (let i = 0; i < 600; i++) await store.createOrder(orderFixture({ phone: "+19990000000", createdAt: new Date("2026-11-03T12:00:00Z") }));
      const mine = orderFixture({ phone, checkoutKind: "card_on_file", status: "awaiting_payment", squarePaymentId: null, createdAt: new Date("2026-11-03T05:00:00Z") });
      await store.createOrder(mine);
      await store.createOrder(orderFixture({ phone, checkoutKind: "card_on_file", createdAt: new Date("2026-11-02T05:00:00Z") })); // too old
      await store.createOrder(orderFixture({ phone, checkoutKind: "link", createdAt: new Date("2026-11-03T06:00:00Z") })); // not a card order
      expect((await store.listCardOrdersSince(phone, since)).map((o) => o.id)).toEqual([mine.id]);
    });

    it("ASAP capacity ignores later intermission orders", async () => {
      const now = new Date("2030-01-01T20:00:00Z");
      const before = await store.countActiveAsapOrders(now);
      await store.createOrder(orderFixture({ status: "paid", pickupAt: new Date(now.getTime() + 60 * 60_000) }));
      await store.createOrder(orderFixture({ status: "paid", pickupAt: null }));
      await store.createOrder(orderFixture({ status: "paid", pickupAt: new Date(now.getTime() - 60_000) }));
      expect(await store.countActiveAsapOrders(now)).toBe(before + 2);
    });
  });
}

storeSuite("Memory store", async () => new MemoryStore());

if (url) {
  it("migrations can run at the same time without failing", async () => {
    const stores = [1, 2, 3, 4].map(() => new PostgresStore(url, "America/Toronto"));
    try {
      await Promise.all(stores.map((s) => s.migrate()));
    } finally {
      await Promise.all(stores.map((s) => s.close()));
    }
  });

  storeSuite(
    "Postgres store (new fields)",
    async () => {
      // Own schema: tests/postgres.test.ts counts every paid order in the shared database.
      const admin = new pg.Client({ connectionString: url });
      await admin.connect();
      await admin.query("CREATE SCHEMA IF NOT EXISTS store_test");
      await admin.end();
      const sep = url.includes("?") ? "&" : "?";
      const s = new PostgresStore(`${url}${sep}options=-c%20search_path%3Dstore_test`, "America/Toronto");
      await s.migrate();
      await s.migrate();
      return s;
    },
    async (s) => (s as PostgresStore).close(),
  );
}
