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
}

export interface SquareOrder {
  id?: string;
  state?: string;
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
  fulfillments?: { uid?: string; type?: string; state?: string }[];
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
  fetchImpl?: typeof fetch;
}): SquareApi {
  const base = opts.env === "production" ? "https://connect.squareup.com" : "https://connect.squareupsandbox.com";
  const f = opts.fetchImpl ?? fetch;

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
  };
}
