import { describe, expect, it } from "vitest";
import { createSquareClient } from "../src/square/client.js";

type Call = { method: string; path: string; body: any };

/** Fake fetch: records each request and answers with the next canned response. */
function client(responses: { status?: number; json: unknown }[]) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const u = new URL(url);
    calls.push({ method: init.method ?? "GET", path: u.pathname + u.search, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const r = responses.shift() ?? { json: {} };
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  const sq = createSquareClient({ accessToken: "t", env: "sandbox", apiVersion: "2026-09-16", locationId: "LOC1", fetchImpl });
  return { sq, calls };
}

describe("Square client: new endpoints", () => {
  it("retrieveLocation reads business hours for the configured location", async () => {
    const periods = [{ day_of_week: "MON", start_local_time: "09:00:00", end_local_time: "17:00:00" }];
    const { sq, calls } = client([{ json: { location: { id: "LOC1", timezone: "America/Winnipeg", business_hours: { periods } } } }]);
    const loc = await sq.retrieveLocation();
    expect(calls[0]).toMatchObject({ method: "GET", path: "/v2/locations/LOC1" });
    expect(loc.business_hours?.periods).toEqual(periods);
  });

  it("searchCustomersByPhone uses an exact phone filter", async () => {
    const { sq, calls } = client([{ json: { customers: [{ id: "C1", given_name: "Riley" }] } }]);
    const out = await sq.searchCustomersByPhone("+18072768533");
    expect(calls[0]).toMatchObject({ method: "POST", path: "/v2/customers/search" });
    expect(calls[0]!.body.query).toEqual({ filter: { phone_number: { exact: "+18072768533" } } });
    expect(out).toEqual([{ id: "C1", given_name: "Riley" }]);
  });

  it("searchCustomersByPhone returns [] when there are no matches", async () => {
    const { sq } = client([{ json: {} }]);
    expect(await sq.searchCustomersByPhone("+18070000000")).toEqual([]);
  });

  it("createCustomer sends name and phone", async () => {
    const { sq, calls } = client([{ json: { customer: { id: "C2" } } }]);
    const c = await sq.createCustomer({ idempotencyKey: "k", givenName: "Riley", phone: "+18072768533" });
    expect(calls[0]).toMatchObject({ method: "POST", path: "/v2/customers" });
    expect(calls[0]!.body).toMatchObject({ idempotency_key: "k", given_name: "Riley", phone_number: "+18072768533" });
    expect(c.id).toBe("C2");
  });

  it("listCards returns only enabled cards for the customer", async () => {
    const { sq, calls } = client([{ json: { cards: [{ id: "ccof:1", enabled: true }, { id: "ccof:2", enabled: false }] } }]);
    const cards = await sq.listCards("C1");
    expect(calls[0]!.path).toBe("/v2/cards?customer_id=C1");
    expect(cards.map((c) => c.id)).toEqual(["ccof:1"]);
  });

  it("disableCard posts to the disable endpoint", async () => {
    const { sq, calls } = client([{ json: { card: { id: "ccof:1" } } }]);
    await sq.disableCard("ccof:1");
    expect(calls[0]).toMatchObject({ method: "POST", path: "/v2/cards/ccof%3A1/disable" });
  });

  it("createOrder sends the order and returns it", async () => {
    const { sq, calls } = client([{ json: { order: { id: "O1", version: 1, total_money: { amount: 875, currency: "CAD" } } } }]);
    const o = await sq.createOrder({ idempotencyKey: "order:1", order: { location_id: "LOC1", line_items: [], customer_id: "C1" } });
    expect(calls[0]).toMatchObject({ method: "POST", path: "/v2/orders" });
    expect(calls[0]!.body).toMatchObject({ idempotency_key: "order:1", order: { customer_id: "C1" } });
    expect(o.version).toBe(1);
  });

  it("createPayment charges a card on file for an order", async () => {
    const { sq, calls } = client([{ json: { payment: { id: "P1", status: "COMPLETED", order_id: "O1" } } }]);
    const p = await sq.createPayment({ idempotencyKey: "card:1", sourceId: "ccof:1", customerId: "C1", orderId: "O1", amount: { amount: 875, currency: "CAD" }, locationId: "LOC1" });
    expect(calls[0]).toMatchObject({ method: "POST", path: "/v2/payments" });
    expect(calls[0]!.body).toEqual({
      idempotency_key: "card:1", source_id: "ccof:1", customer_id: "C1", order_id: "O1",
      amount_money: { amount: 875, currency: "CAD" }, location_id: "LOC1", autocomplete: true,
    });
    expect(p.status).toBe("COMPLETED");
  });

  it("createInvoice turns on the save-my-card checkbox and shares manually", async () => {
    const { sq, calls } = client([{ json: { invoice: { id: "inv:1", version: 0 } } }]);
    const inv = await sq.createInvoice({ idempotencyKey: "k", orderId: "O1", customerId: "C1", locationId: "LOC1", dueDate: "2026-11-08" });
    expect(calls[0]).toMatchObject({ method: "POST", path: "/v2/invoices" });
    expect(calls[0]!.body.invoice).toMatchObject({
      location_id: "LOC1", order_id: "O1", primary_recipient: { customer_id: "C1" },
      delivery_method: "SHARE_MANUALLY", store_payment_method_enabled: true,
      payment_requests: [{ request_type: "BALANCE", due_date: "2026-11-08" }],
      accepted_payment_methods: { card: true, square_gift_card: false, bank_account: false, buy_now_pay_later: false, cash_app_pay: false },
    });
    expect(inv).toEqual({ id: "inv:1", version: 0 });
  });

  it("publishInvoice returns the public payment page", async () => {
    const { sq, calls } = client([{ json: { invoice: { id: "inv:1", version: 1, public_url: "https://squareupsandbox.com/pay-invoice/x" } } }]);
    const inv = await sq.publishInvoice("inv:1", 0, "k");
    expect(calls[0]).toMatchObject({ method: "POST", path: "/v2/invoices/inv%3A1/publish", body: { version: 0, idempotency_key: "k" } });
    expect(inv.public_url).toContain("pay-invoice");
  });

  it("cancelInvoice tolerates an invoice that's already gone", async () => {
    const { sq, calls } = client([{ status: 404, json: { errors: [{ code: "NOT_FOUND" }] } }]);
    await expect(sq.cancelInvoice("inv:1", 1)).resolves.toBeUndefined();
    expect(calls[0]).toMatchObject({ method: "POST", path: "/v2/invoices/inv%3A1/cancel", body: { version: 1 } });
  });

  it("updatePickupAt changes only the fulfillment's pickup time", async () => {
    const { sq, calls } = client([{ json: { order: { id: "O1", version: 3 } } }]);
    await sq.updatePickupAt({ orderId: "O1", version: 2, fulfillmentUid: "F1", pickupAt: new Date("2026-11-08T21:46:00Z") });
    expect(calls[0]).toMatchObject({ method: "PUT", path: "/v2/orders/O1" });
    expect(calls[0]!.body.order).toEqual({
      location_id: "LOC1", version: 2,
      fulfillments: [{ uid: "F1", pickup_details: { pickup_at: "2026-11-08T21:46:00.000Z" } }],
    });
  });

  it("retrieveLoyaltyProgram returns null when the seller has no program", async () => {
    const { sq, calls } = client([{ status: 404, json: { errors: [{ code: "NOT_FOUND" }] } }]);
    expect(await sq.retrieveLoyaltyProgram()).toBeNull();
    expect(calls[0]!.path).toBe("/v2/loyalty/programs/main");
  });

  it("retrieveLoyaltyProgram returns tiers when there is one", async () => {
    const program = { id: "LP1", reward_tiers: [{ id: "T1", name: "Free coffee", points: 10 }] };
    const { sq } = client([{ json: { program } }]);
    expect(await sq.retrieveLoyaltyProgram()).toEqual(program);
  });

  it("searchLoyaltyAccount finds the account by customer id", async () => {
    const { sq, calls } = client([{ json: { loyalty_accounts: [{ id: "LA1", balance: 12 }] } }]);
    expect(await sq.searchLoyaltyAccount("C1")).toEqual({ id: "LA1", balance: 12 });
    expect(calls[0]).toMatchObject({ method: "POST", path: "/v2/loyalty/accounts/search", body: { query: { customer_ids: ["C1"] } } });
  });

  it("searchLoyaltyAccount returns null for non-members", async () => {
    const { sq } = client([{ json: {} }]);
    expect(await sq.searchLoyaltyAccount("C1")).toBeNull();
  });

  it("accumulateLoyalty adds points for a completed order", async () => {
    const { sq, calls } = client([{ json: { events: [] } }]);
    await sq.accumulateLoyalty({ accountId: "LA1", orderId: "O1", locationId: "LOC1", idempotencyKey: "loyalty:1" });
    expect(calls[0]).toMatchObject({
      method: "POST", path: "/v2/loyalty/accounts/LA1/accumulate",
      body: { accumulate_points: { order_id: "O1" }, location_id: "LOC1", idempotency_key: "loyalty:1" },
    });
  });

  it("createLoyaltyReward attaches a reward to an order", async () => {
    const { sq, calls } = client([{ json: { reward: { id: "R1" } } }]);
    await sq.createLoyaltyReward({ accountId: "LA1", rewardTierId: "T1", orderId: "O1", idempotencyKey: "k" });
    expect(calls[0]).toMatchObject({
      method: "POST", path: "/v2/loyalty/rewards",
      body: { reward: { loyalty_account_id: "LA1", reward_tier_id: "T1", order_id: "O1" }, idempotency_key: "k" },
    });
  });
});
