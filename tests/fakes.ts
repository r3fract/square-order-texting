import type { ContentBlock, ModelClient, ModelRequest, ModelResponse } from "../src/agent.js";
import { loadConfig, type Config } from "../src/config.js";
import type { SquareApi, SquareCatalogObject, SquareOrder, SquareOrderInput } from "../src/square/client.js";
import type { SmsSender } from "../src/sms.js";

export const LOC = "LOC1";
const cad = (amount: number) => ({ amount, currency: "CAD" });

/** A small canteen catalog in Square's JSON shape. */
export function canteenCatalog(): SquareCatalogObject[] {
  return [
    { type: "CATEGORY", id: "CAT_HOT", category_data: { name: "Hot food" } },
    { type: "CATEGORY", id: "CAT_DRINK", category_data: { name: "Sips" } },
    {
      type: "MODIFIER_LIST",
      id: "ML_POUTINE",
      modifier_list_data: {
        name: "Poutine extras",
        selection_type: "MULTIPLE",
        modifiers: [
          { type: "MODIFIER", id: "MOD_CURDS", modifier_data: { name: "Extra curds", price_money: cad(150) } },
          { type: "MODIFIER", id: "MOD_NOGRAVY", modifier_data: { name: "Gravy on the side", price_money: cad(0) } },
        ],
      },
    },
    {
      type: "MODIFIER_LIST",
      id: "ML_BASE",
      modifier_list_data: {
        name: "Soda base",
        selection_type: "SINGLE",
        modifiers: [
          { type: "MODIFIER", id: "MOD_DRP", modifier_data: { name: "Dr Pepper" } },
          { type: "MODIFIER", id: "MOD_COKE", modifier_data: { name: "Coke" } },
        ],
      },
    },
    {
      type: "MODIFIER_LIST",
      id: "ML_SHOTS",
      modifier_list_data: {
        name: "Flavour shots",
        selection_type: "MULTIPLE",
        modifiers: [
          { type: "MODIFIER", id: "MOD_COCO", modifier_data: { name: "Coconut", price_money: cad(50) } },
          { type: "MODIFIER", id: "MOD_LIME", modifier_data: { name: "Lime", price_money: cad(50) } },
          {
            type: "MODIFIER",
            id: "MOD_VAN",
            modifier_data: { name: "Vanilla", price_money: cad(50), location_overrides: [{ location_id: LOC, sold_out: true }] },
          },
        ],
      },
    },
    {
      type: "ITEM",
      id: "IT_POUTINE",
      item_data: {
        name: "Poutine",
        categories: [{ id: "CAT_HOT" }],
        variations: [{ type: "ITEM_VARIATION", id: "V_POUTINE", item_variation_data: { name: "Regular", price_money: cad(900) } }],
        modifier_list_info: [{ modifier_list_id: "ML_POUTINE", min_selected_modifiers: -1, max_selected_modifiers: -1 }],
      },
    },
    {
      type: "ITEM",
      id: "IT_FRIES",
      item_data: {
        name: "Fries",
        categories: [{ id: "CAT_HOT" }],
        variations: [
          { type: "ITEM_VARIATION", id: "V_FRIES_S", item_variation_data: { name: "Small", price_money: cad(400) } },
          { type: "ITEM_VARIATION", id: "V_FRIES_L", item_variation_data: { name: "Large", price_money: cad(600) } },
        ],
      },
    },
    {
      type: "ITEM",
      id: "IT_MOZZA",
      item_data: {
        name: "Mozza Sticks",
        categories: [{ id: "CAT_HOT" }],
        variations: [{ type: "ITEM_VARIATION", id: "V_MOZZA", item_variation_data: { name: "Regular", price_money: cad(800), track_inventory: true } }],
      },
    },
    {
      type: "ITEM",
      id: "IT_SODA",
      item_data: {
        name: "Dirty Soda",
        categories: [{ id: "CAT_DRINK" }],
        variations: [{ type: "ITEM_VARIATION", id: "V_SODA", item_variation_data: { name: "Regular", price_money: cad(500) } }],
        modifier_list_info: [
          { modifier_list_id: "ML_BASE", min_selected_modifiers: 1, max_selected_modifiers: 1 },
          { modifier_list_id: "ML_SHOTS", min_selected_modifiers: -1, max_selected_modifiers: 2 },
        ],
      },
    },
    {
      type: "ITEM",
      id: "IT_OLD",
      item_data: {
        name: "Archived Thing",
        is_archived: true,
        variations: [{ type: "ITEM_VARIATION", id: "V_OLD", item_variation_data: { name: "Regular", price_money: cad(100) } }],
      },
    },
  ];
}

/** In-memory Square that prices orders the way Square would for a simple 13% HST setup. */
export class FakeSquare implements SquareApi {
  catalog = canteenCatalog();
  stock = new Map<string, number>([["V_MOZZA", 0]]);
  links = new Map<string, { url: string; orderId: string; deleted: boolean; order: SquareOrderInput }>();
  calls: string[] = [];
  private seq = 0;

  async listCatalog() {
    this.calls.push("listCatalog");
    return this.catalog;
  }
  async inventoryCounts(ids: string[]) {
    this.calls.push("inventoryCounts");
    return new Map(ids.filter((id) => this.stock.has(id)).map((id) => [id, this.stock.get(id)!]));
  }
  private price(order: SquareOrderInput): SquareOrder {
    const findObj = (id: string): SquareCatalogObject | undefined => {
      for (const o of this.catalog) {
        if (o.id === id) return o;
        for (const v of o.item_data?.variations ?? []) if (v.id === id) return { ...v, item_variation_data: { ...v.item_variation_data, item_id: o.id } };
        for (const m of o.modifier_list_data?.modifiers ?? []) if (m.id === id) return m;
      }
      return undefined;
    };
    let subtotal = 0;
    const line_items = order.line_items.map((li) => {
      const v = findObj(li.catalog_object_id)!;
      const item = this.catalog.find((o) => o.id === v.item_variation_data?.item_id)!;
      const qty = Number(li.quantity);
      const mods = (li.modifiers ?? []).map((m) => findObj(m.catalog_object_id)!);
      const unit = (v.item_variation_data?.price_money?.amount ?? 0) + mods.reduce((s, m) => s + (m.modifier_data?.price_money?.amount ?? 0), 0);
      subtotal += unit * qty;
      return {
        quantity: li.quantity,
        name: item.item_data?.name,
        variation_name: v.item_variation_data?.name,
        catalog_object_id: li.catalog_object_id,
        modifiers: mods.map((m) => ({ name: m.modifier_data?.name, catalog_object_id: m.id })),
        gross_sales_money: cad(unit * qty),
      };
    });
    const tax = Math.round(subtotal * 0.13);
    return { line_items, total_tax_money: cad(tax), total_discount_money: cad(0), total_money: cad(subtotal + tax) };
  }
  async calculateOrder(order: SquareOrderInput) {
    this.calls.push("calculateOrder");
    return this.price(order);
  }
  async createPaymentLink({ order }: { idempotencyKey: string; order: SquareOrderInput }) {
    this.calls.push("createPaymentLink");
    const n = ++this.seq;
    const link = { id: `PL${n}`, url: `https://square.link/u/test${n}`, order_id: `SQORD${n}` };
    this.links.set(link.id, { url: link.url, orderId: link.order_id, deleted: false, order });
    return { link, order: { ...this.price(order), id: link.order_id } };
  }
  async deletePaymentLink(id: string) {
    this.calls.push(`deletePaymentLink:${id}`);
    const l = this.links.get(id);
    if (l) l.deleted = true;
  }
  async retrieveOrder(id: string) {
    const l = [...this.links.values()].find((x) => x.orderId === id)!;
    return { ...this.price(l.order), id };
  }
}

export class FakeSms implements SmsSender {
  sent: { to: string; body: string }[] = [];
  async send(to: string, body: string) {
    this.sent.push({ to, body });
  }
  to(phone: string) {
    return this.sent.filter((s) => s.to === phone).map((s) => s.body);
  }
  last(phone: string) {
    return this.to(phone).at(-1) ?? "";
  }
}

type Step = (req: ModelRequest) => ContentBlock[] | ModelResponse;

/** Model that plays back scripted turns and records every request it got. */
export class ScriptedModel implements ModelClient {
  requests: ModelRequest[] = [];
  constructor(private steps: Step[] = []) {}
  push(...steps: Step[]) {
    this.steps.push(...steps);
  }
  async create(req: ModelRequest): Promise<ModelResponse> {
    this.requests.push(structuredClone(req));
    const step = this.steps.shift();
    if (!step) throw new Error("ScriptedModel ran out of steps");
    const out = step(req);
    if (!Array.isArray(out)) return out;
    return { content: out, stop_reason: out.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn" };
  }
}

let toolSeq = 0;
export const say = (text: string): Step => () => [{ type: "text", text }];
export const tool = (name: string, input: unknown = {}, text?: string): Step => () => [
  ...(text ? [{ type: "text" as const, text }] : []),
  { type: "tool_use", id: `tu_${++toolSeq}`, name, input },
];

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    PUBLIC_BASE_URL: "https://order.example.com",
    OWNER_PHONE: "+18075550100",
    SQUARE_ACCESS_TOKEN: "sq-token",
    SQUARE_LOCATION_ID: LOC,
    SQUARE_WEBHOOK_SIGNATURE_KEY: "sq-sig-key",
    TWILIO_ACCOUNT_SID: "ACtest",
    TWILIO_AUTH_TOKEN: "twilio-token",
    TWILIO_FROM_NUMBER: "+18075550147",
    ANTHROPIC_API_KEY: "sk-test",
    ADMIN_TOKEN: "admin-token-1234567890",
    TIMEZONE: "America/Toronto",
    ...overrides,
  });
}
