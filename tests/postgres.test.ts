import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresStore } from "../src/store/postgres.js";

// Runs only when TEST_DATABASE_URL points at a throwaway database.
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("Postgres store", () => {
  let store: PostgresStore;
  beforeAll(async () => {
    store = new PostgresStore(url!, "America/Toronto");
    await store.migrate();
    await store.migrate(); // safe to run twice
  });
  afterAll(async () => {
    await store.close();
  });

  it("round-trips conversations, orders, settings and events", async () => {
    const phone = `+1807${Math.floor(Math.random() * 1e7)}`;
    const conv = await store.getConversation(phone);
    expect(conv.messages).toEqual([]);
    conv.customerName = "Jordan";
    conv.cart = [{ variationId: "V1", quantity: 2, modifierIds: ["M1"] }];
    conv.messages = [{ role: "user", content: "hi" }, { role: "assistant", content: [{ type: "text", text: "hey" }] }];
    conv.updatedAt = new Date("2026-11-03T23:00:00Z");
    await store.saveConversation(conv);
    const back = await store.getConversation(phone);
    expect(back).toMatchObject({ customerName: "Jordan", cart: conv.cart, messages: conv.messages, optedOut: false });
    expect(back.updatedAt.toISOString()).toBe("2026-11-03T23:00:00.000Z");

    const n1 = await store.nextOrderNumber();
    const n2 = await store.nextOrderNumber();
    expect(n2).toBe(n1 + 1);

    const id = `o-${phone}`;
    await store.createOrder({
      id, phone, orderNumber: n2, squareOrderId: `SQ-${phone}`, paymentLinkId: "PL", paymentLinkUrl: "https://x",
      totalCents: 3334, currency: "CAD", summary: "s", status: "awaiting_payment",
      createdAt: new Date("2026-11-03T23:00:00Z"), paidAt: null, readyAt: null,
      checkoutKind: "link", invoiceId: null, invoiceVersion: null, squarePaymentId: null, customerId: null, cart: [],
      pickupAt: null, pickupSlot: "asap", quotedReadyAt: null, etaNotifiedAt: null,
    });
    expect((await store.getAwaitingOrderForPhone(phone))!.id).toBe(id);
    expect((await store.listAwaitingCreatedBefore(new Date("2026-11-03T23:30:00Z"))).some((o) => o.id === id)).toBe(true);
    const before = await store.countActiveOrders();
    await store.updateOrder(id, { status: "paid", paidAt: new Date() });
    expect(await store.countActiveOrders()).toBe(before + 1);
    expect((await store.getOrderBySquareId(`SQ-${phone}`))!.status).toBe("paid");

    await store.setSetting("paused", "true");
    expect(await store.getSetting("paused")).toBe("true");
    expect(await store.claimEvent(`e-${phone}`)).toBe(true);
    expect(await store.claimEvent(`e-${phone}`)).toBe(false);
  });
});
