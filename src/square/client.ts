/**
 * Thin Square REST client. Uses plain fetch so the Square API version is pinned by config,
 * not by whichever SDK version happens to be installed.
 * Field names are Square's snake_case JSON.
 */

export interface Money {
  amount: number; // smallest unit (cents)
  currency: string;
}

export interface SquareCatalogObject {
  type: string;
  id: string;
  is_deleted?: boolean;
  present_at_all_locations?: boolean;
  present_at_location_ids?: string[];
  absent_at_location_ids?: string[];
  item_data?: {
    name?: string;
    description?: string;
    is_archived?: boolean;
    category_id?: string;
    categories?: { id: string }[];
    variations?: SquareCatalogObject[];
    modifier_list_info?: {
      modifier_list_id: string;
      min_selected_modifiers?: number;
      max_selected_modifiers?: number;
      enabled?: boolean;
    }[];
  };
  item_variation_data?: {
    item_id?: string;
    name?: string;
    price_money?: Money;
    pricing_type?: "FIXED_PRICING" | "VARIABLE_PRICING";
    track_inventory?: boolean;
    sellable?: boolean;
    location_overrides?: {
      location_id?: string;
      track_inventory?: boolean;
      sold_out?: boolean;
      price_money?: Money;
    }[];
  };
  modifier_list_data?: {
    name?: string;
    selection_type?: "SINGLE" | "MULTIPLE";
    modifiers?: SquareCatalogObject[];
  };
  modifier_data?: {
    name?: string;
    price_money?: Money;
    location_overrides?: { location_id?: string; sold_out?: boolean; price_money?: Money }[];
  };
  category_data?: { name?: string };
}

export interface SquareOrderLineItemInput {
  catalog_object_id: string;
  quantity: string;
  modifiers?: { catalog_object_id: string }[];
  note?: string;
}

export interface SquareOrderInput {
  location_id: string;
  reference_id?: string;
  line_items: SquareOrderLineItemInput[];
  fulfillments?: unknown[];
  metadata?: Record<string, string>;
  customer_id?: string;
}

export interface SquareOrder {
  id?: string;
  version?: number;
  state?: string;
  tenders?: { id?: string; type?: string }[];
  line_items?: {
    uid?: string;
    name?: string;
    variation_name?: string;
    quantity: string;
    catalog_object_id?: string;
    modifiers?: { name?: string; catalog_object_id?: string; total_price_money?: Money }[];
    gross_sales_money?: Money;
    total_money?: Money;
  }[];
  total_money?: Money;
  total_tax_money?: Money;
  total_discount_money?: Money;
  fulfillments?: { uid?: string; type?: string; state?: string; pickup_details?: { pickup_at?: string } }[];
}

export interface BusinessHoursPeriod {
  day_of_week: string;
  start_local_time: string;
  end_local_time: string;
}
export interface SquareLocation {
  timezone?: string;
  business_hours?: { periods?: BusinessHoursPeriod[] };
}
export interface SquareCustomer {
  id: string;
  given_name?: string;
  family_name?: string;
  phone_number?: string;
  created_at?: string;
}
export interface SquareCard {
  id: string;
  card_brand?: string;
  last_4?: string;
  enabled?: boolean;
  /** Same physical card saved twice → same fingerprint. */
  fingerprint?: string;
  created_at?: string;
}
export interface SquarePayment {
  id: string;
  status: string;
  order_id?: string;
  card_details?: { status?: string };
}
export interface SquareInvoice {
  id: string;
  version: number;
  status?: string;
  public_url?: string;
  order_id?: string;
}
export interface LoyaltyProgram {
  id: string;
  reward_tiers: { id: string; name: string; points: number }[];
  terminology?: { one?: string; other?: string };
}
export interface LoyaltyAccount {
  id: string;
  balance: number;
}

export interface PaymentLink {
  id: string;
  url: string;
  order_id: string;
  version?: number;
}

export interface SquareApi {
  listCatalog(): Promise<SquareCatalogObject[]>;
  inventoryCounts(variationIds: string[], locationId: string): Promise<Map<string, number>>;
  calculateOrder(order: SquareOrderInput): Promise<SquareOrder>;
  createPaymentLink(args: {
    idempotencyKey: string;
    order: SquareOrderInput;
    buyerPhone?: string;
    redirectUrl?: string;
    allowTipping?: boolean;
  }): Promise<{ link: PaymentLink; order?: SquareOrder }>;
  deletePaymentLink(id: string): Promise<void>;
  retrieveOrder(id: string): Promise<SquareOrder>;

  retrieveLocation(): Promise<SquareLocation>;
  searchCustomersByPhone(phone: string): Promise<SquareCustomer[]>;
  createCustomer(a: { idempotencyKey: string; givenName: string; phone: string }): Promise<SquareCustomer>;
  listCards(customerId: string): Promise<SquareCard[]>;
  disableCard(cardId: string): Promise<void>;
  createOrder(a: { idempotencyKey: string; order: SquareOrderInput }): Promise<SquareOrder>;
  createPayment(a: { idempotencyKey: string; sourceId: string; customerId: string; orderId: string; amount: Money; locationId: string }): Promise<SquarePayment>;
  createInvoice(a: { idempotencyKey: string; orderId: string; customerId: string; locationId: string; dueDate: string }): Promise<SquareInvoice>;
  publishInvoice(id: string, version: number, idempotencyKey: string): Promise<SquareInvoice>;
  cancelInvoice(id: string, version: number): Promise<void>;
  updatePickupAt(a: { orderId: string; version: number; fulfillmentUid: string; pickupAt: Date }): Promise<SquareOrder>;
  retrieveLoyaltyProgram(): Promise<LoyaltyProgram | null>;
  searchLoyaltyAccount(customerId: string): Promise<LoyaltyAccount | null>;
  accumulateLoyalty(a: { accountId: string; orderId: string; locationId: string; idempotencyKey: string }): Promise<void>;
  createLoyaltyReward(a: { accountId: string; rewardTierId: string; orderId: string; idempotencyKey: string }): Promise<{ id: string }>;
  /** Releases a reward (and its points) from an order that won't be paid. */
  deleteLoyaltyReward(id: string): Promise<void>;
}

export class SquareError extends Error {
  constructor(
    message: string,
    public status: number,
    public errors: { category?: string; code?: string; detail?: string; field?: string }[] = [],
  ) {
    super(message);
  }
}

export function createSquareClient(opts: {
  accessToken: string;
  env: "sandbox" | "production";
  apiVersion: string;
  locationId: string;
  fetchImpl?: typeof fetch;
}): SquareApi {
  const base = opts.env === "production" ? "https://connect.squareup.com" : "https://connect.squareupsandbox.com";
  const f = opts.fetchImpl ?? fetch;
  const enc = encodeURIComponent;

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await f(base + path, {
      method,
      headers: {
        Authorization: `Bearer ${opts.accessToken}`,
        "Square-Version": opts.apiVersion,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const errs = json.errors ?? [];
      const detail = errs.map((e: { code?: string; detail?: string }) => `${e.code}: ${e.detail}`).join("; ");
      throw new SquareError(`Square ${method} ${path} failed (${res.status}) ${detail}`, res.status, errs);
    }
    return json as T;
  }

  return {
    async listCatalog() {
      const out: SquareCatalogObject[] = [];
      let cursor: string | undefined;
      do {
        const q = new URLSearchParams({ types: "ITEM,MODIFIER_LIST,CATEGORY" });
        if (cursor) q.set("cursor", cursor);
        const page = await call<{ objects?: SquareCatalogObject[]; cursor?: string }>("GET", `/v2/catalog/list?${q}`);
        out.push(...(page.objects ?? []));
        cursor = page.cursor;
      } while (cursor);
      return out;
    },

    async inventoryCounts(variationIds, locationId) {
      const counts = new Map<string, number>();
      if (variationIds.length === 0) return counts;
      // Square allows up to 1000 ids per request.
      for (let i = 0; i < variationIds.length; i += 500) {
        let cursor: string | undefined;
        do {
          const page = await call<{
            counts?: { catalog_object_id: string; state: string; quantity: string; location_id: string }[];
            cursor?: string;
          }>("POST", "/v2/inventory/counts/batch-retrieve", {
            catalog_object_ids: variationIds.slice(i, i + 500),
            location_ids: [locationId],
            states: ["IN_STOCK"],
            cursor,
          });
          for (const c of page.counts ?? []) {
            counts.set(c.catalog_object_id, (counts.get(c.catalog_object_id) ?? 0) + Number(c.quantity));
          }
          cursor = page.cursor;
        } while (cursor);
      }
      return counts;
    },

    async calculateOrder(order) {
      const res = await call<{ order: SquareOrder }>("POST", "/v2/orders/calculate", { order });
      return res.order;
    },

    async createPaymentLink({ idempotencyKey, order, buyerPhone, redirectUrl, allowTipping }) {
      const res = await call<{
        payment_link: PaymentLink;
        related_resources?: { orders?: SquareOrder[] };
      }>("POST", "/v2/online-checkout/payment-links", {
        idempotency_key: idempotencyKey,
        order,
        checkout_options: {
          accepted_payment_methods: { apple_pay: true, google_pay: true },
          allow_tipping: allowTipping ?? false,
          ...(redirectUrl ? { redirect_url: redirectUrl } : {}),
        },
        ...(buyerPhone ? { pre_populated_data: { buyer_phone_number: buyerPhone } } : {}),
      });
      return { link: res.payment_link, order: res.related_resources?.orders?.[0] };
    },

    async deletePaymentLink(id) {
      try {
        await call("DELETE", `/v2/online-checkout/payment-links/${encodeURIComponent(id)}`);
      } catch (e) {
        if (e instanceof SquareError && e.status === 404) return; // already gone
        throw e;
      }
    },

    async retrieveOrder(id) {
      const res = await call<{ order: SquareOrder }>("GET", `/v2/orders/${encodeURIComponent(id)}`);
      return res.order;
    },

    async retrieveLocation() {
      const res = await call<{ location: SquareLocation }>("GET", `/v2/locations/${enc(opts.locationId)}`);
      return res.location;
    },

    async searchCustomersByPhone(phone) {
      const res = await call<{ customers?: SquareCustomer[] }>("POST", "/v2/customers/search", {
        query: { filter: { phone_number: { exact: phone } } },
      });
      return res.customers ?? [];
    },

    async createCustomer({ idempotencyKey, givenName, phone }) {
      const res = await call<{ customer: SquareCustomer }>("POST", "/v2/customers", {
        idempotency_key: idempotencyKey,
        given_name: givenName,
        phone_number: phone,
      });
      return res.customer;
    },

    async listCards(customerId) {
      const res = await call<{ cards?: SquareCard[] }>("GET", `/v2/cards?${new URLSearchParams({ customer_id: customerId })}`);
      return (res.cards ?? []).filter((c) => c.enabled !== false);
    },

    async disableCard(cardId) {
      await call("POST", `/v2/cards/${enc(cardId)}/disable`);
    },

    async createOrder({ idempotencyKey, order }) {
      const res = await call<{ order: SquareOrder }>("POST", "/v2/orders", { idempotency_key: idempotencyKey, order });
      return res.order;
    },

    async createPayment({ idempotencyKey, sourceId, customerId, orderId, amount, locationId }) {
      const res = await call<{ payment: SquarePayment }>("POST", "/v2/payments", {
        idempotency_key: idempotencyKey,
        source_id: sourceId,
        customer_id: customerId,
        order_id: orderId,
        amount_money: amount,
        location_id: locationId,
        autocomplete: true,
      });
      return res.payment;
    },

    async createInvoice({ idempotencyKey, orderId, customerId, locationId, dueDate }) {
      const res = await call<{ invoice: SquareInvoice }>("POST", "/v2/invoices", {
        idempotency_key: idempotencyKey,
        invoice: {
          location_id: locationId,
          order_id: orderId,
          primary_recipient: { customer_id: customerId },
          delivery_method: "SHARE_MANUALLY",
          store_payment_method_enabled: true,
          payment_requests: [{ request_type: "BALANCE", due_date: dueDate }],
          accepted_payment_methods: { card: true, square_gift_card: false, bank_account: false, buy_now_pay_later: false, cash_app_pay: false },
        },
      });
      return res.invoice;
    },

    async publishInvoice(id, version, idempotencyKey) {
      const res = await call<{ invoice: SquareInvoice }>("POST", `/v2/invoices/${enc(id)}/publish`, { version, idempotency_key: idempotencyKey });
      return res.invoice;
    },

    async cancelInvoice(id, version) {
      try {
        await call("POST", `/v2/invoices/${enc(id)}/cancel`, { version });
      } catch (e) {
        if (e instanceof SquareError && e.status === 404) return; // already gone
        throw e;
      }
    },

    async updatePickupAt({ orderId, version, fulfillmentUid, pickupAt }) {
      const res = await call<{ order: SquareOrder }>("PUT", `/v2/orders/${enc(orderId)}`, {
        order: {
          location_id: opts.locationId,
          version,
          fulfillments: [{ uid: fulfillmentUid, pickup_details: { pickup_at: pickupAt.toISOString() } }],
        },
      });
      return res.order;
    },

    async retrieveLoyaltyProgram() {
      try {
        const res = await call<{ program: LoyaltyProgram }>("GET", "/v2/loyalty/programs/main");
        return res.program ?? null;
      } catch (e) {
        if (e instanceof SquareError && e.status === 404) return null; // seller doesn't use Square Loyalty
        throw e;
      }
    },

    async searchLoyaltyAccount(customerId) {
      const res = await call<{ loyalty_accounts?: LoyaltyAccount[] }>("POST", "/v2/loyalty/accounts/search", {
        query: { customer_ids: [customerId] },
      });
      const a = res.loyalty_accounts?.[0];
      return a ? { id: a.id, balance: a.balance ?? 0 } : null;
    },

    async accumulateLoyalty({ accountId, orderId, locationId, idempotencyKey }) {
      await call("POST", `/v2/loyalty/accounts/${enc(accountId)}/accumulate`, {
        accumulate_points: { order_id: orderId },
        location_id: locationId,
        idempotency_key: idempotencyKey,
      });
    },

    async createLoyaltyReward({ accountId, rewardTierId, orderId, idempotencyKey }) {
      const res = await call<{ reward: { id: string } }>("POST", "/v2/loyalty/rewards", {
        reward: { loyalty_account_id: accountId, reward_tier_id: rewardTierId, order_id: orderId },
        idempotency_key: idempotencyKey,
      });
      return { id: res.reward.id };
    },

    async deleteLoyaltyReward(id) {
      try {
        await call("DELETE", `/v2/loyalty/rewards/${enc(id)}`);
      } catch (e) {
        if (e instanceof SquareError && e.status === 404) return;
        throw e;
      }
    },
  };
}
