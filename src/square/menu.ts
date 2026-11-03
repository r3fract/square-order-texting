import type { Money, SquareApi, SquareCatalogObject } from "./client.js";

export interface MenuModifier {
  id: string;
  name: string;
  priceCents: number;
  soldOut: boolean;
}

export interface MenuModifierList {
  id: string;
  name: string;
  min: number; // 0 = optional
  max: number | null; // null = no limit
  modifiers: MenuModifier[];
}

export interface MenuVariation {
  id: string;
  name: string;
  priceCents: number | null; // null = variable price (can't be ordered by text)
  trackInventory: boolean;
  soldOut: boolean;
}

export interface MenuItem {
  id: string;
  name: string;
  description: string;
  category: string;
  variations: MenuVariation[];
  modifierLists: MenuModifierList[];
}

export interface Menu {
  currency: string;
  items: MenuItem[];
  byVariation: Map<string, { item: MenuItem; variation: MenuVariation }>;
  loadedAt: number;
}

function presentAt(o: SquareCatalogObject, loc: string): boolean {
  if (o.is_deleted) return false;
  if (o.absent_at_location_ids?.includes(loc)) return false;
  if (o.present_at_all_locations === false) return !!o.present_at_location_ids?.includes(loc);
  return true;
}

export function buildMenu(objects: SquareCatalogObject[], locationId: string): Menu {
  const categories = new Map<string, string>();
  const modLists = new Map<string, SquareCatalogObject>();
  for (const o of objects) {
    if (o.type === "CATEGORY") categories.set(o.id, o.category_data?.name ?? "");
    if (o.type === "MODIFIER_LIST") modLists.set(o.id, o);
  }

  let currency = "CAD";
  const items: MenuItem[] = [];
  for (const o of objects) {
    if (o.type !== "ITEM" || !o.item_data || o.item_data.is_archived || !presentAt(o, locationId)) continue;
    const d = o.item_data;

    const variations: MenuVariation[] = [];
    for (const v of d.variations ?? []) {
      const vd = v.item_variation_data;
      if (!vd || !presentAt(v, locationId) || vd.sellable === false) continue;
      const ov = vd.location_overrides?.find((x) => x.location_id === locationId);
      const price: Money | undefined = ov?.price_money ?? vd.price_money;
      if (price?.currency) currency = price.currency;
      variations.push({
        id: v.id,
        name: vd.name ?? "Regular",
        priceCents: vd.pricing_type === "VARIABLE_PRICING" || !price ? null : price.amount,
        trackInventory: ov?.track_inventory ?? vd.track_inventory ?? false,
        soldOut: ov?.sold_out ?? false,
      });
    }
    if (variations.length === 0) continue;

    const modifierLists: MenuModifierList[] = [];
    for (const info of d.modifier_list_info ?? []) {
      if (info.enabled === false) continue;
      const ml = modLists.get(info.modifier_list_id);
      if (!ml?.modifier_list_data || !presentAt(ml, locationId)) continue;
      const single = ml.modifier_list_data.selection_type === "SINGLE";
      const min = info.min_selected_modifiers != null && info.min_selected_modifiers >= 0 ? info.min_selected_modifiers : 0;
      const maxRaw = info.max_selected_modifiers != null && info.max_selected_modifiers >= 0 ? info.max_selected_modifiers : null;
      modifierLists.push({
        id: ml.id,
        name: ml.modifier_list_data.name ?? "Options",
        min,
        max: single ? 1 : maxRaw,
        modifiers: (ml.modifier_list_data.modifiers ?? [])
          .filter((m) => m.modifier_data && presentAt(m, locationId))
          .map((m) => {
            const ov = m.modifier_data!.location_overrides?.find((x) => x.location_id === locationId);
            return {
              id: m.id,
              name: m.modifier_data!.name ?? "",
              priceCents: (ov?.price_money ?? m.modifier_data!.price_money)?.amount ?? 0,
              soldOut: ov?.sold_out ?? false,
            };
          }),
      });
    }

    const catId = d.categories?.[0]?.id ?? d.category_id;
    items.push({
      id: o.id,
      name: d.name ?? "",
      description: d.description ?? "",
      category: (catId && categories.get(catId)) || "Menu",
      variations,
      modifierLists,
    });
  }

  items.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  const byVariation = new Map<string, { item: MenuItem; variation: MenuVariation }>();
  for (const item of items) for (const variation of item.variations) byVariation.set(variation.id, { item, variation });
  return { currency, items, byVariation, loadedAt: Date.now() };
}

export function formatMoney(cents: number, currency = "CAD"): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const symbol = currency === "CAD" || currency === "USD" ? "$" : `${currency} `;
  return `${sign}${symbol}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** Compact menu text for the model. IDs are included so the model can reference exact catalog objects. */
export function menuForModel(menu: Menu, stock: Map<string, number>): string {
  const lines: string[] = [];
  let cat = "";
  for (const item of menu.items) {
    if (item.category !== cat) {
      cat = item.category;
      lines.push(`\n## ${cat}`);
    }
    lines.push(`- ${item.name}${item.description ? ` — ${item.description}` : ""}`);
    for (const v of item.variations) {
      const avail = variationAvailable(v, stock);
      const price = v.priceCents == null ? "price varies (not orderable by text)" : formatMoney(v.priceCents, menu.currency);
      lines.push(`  - variation "${v.name}" id=${v.id} ${price}${avail ? "" : " [SOLD OUT]"}`);
    }
    for (const ml of item.modifierLists) {
      const rule = ml.min > 0 ? `required, pick ${ml.min}${ml.max && ml.max !== ml.min ? `-${ml.max}` : ""}` : ml.max ? `optional, up to ${ml.max}` : "optional";
      lines.push(`  - options "${ml.name}" (${rule}):`);
      for (const m of ml.modifiers) {
        lines.push(`    - "${m.name}" id=${m.id}${m.priceCents ? ` +${formatMoney(m.priceCents, menu.currency)}` : ""}${m.soldOut ? " [SOLD OUT]" : ""}`);
      }
    }
  }
  return lines.join("\n").trim();
}

export function variationAvailable(v: MenuVariation, stock: Map<string, number>): boolean {
  if (v.soldOut || v.priceCents == null) return false;
  if (!v.trackInventory) return true;
  return (stock.get(v.id) ?? 0) > 0;
}

/** Caches the catalog briefly; inventory is always read fresh when it matters. */
export class MenuService {
  private cached: Menu | null = null;
  constructor(
    private square: SquareApi,
    private locationId: string,
    private ttlMs = 60_000,
  ) {}

  async getMenu(force = false): Promise<Menu> {
    if (!force && this.cached && Date.now() - this.cached.loadedAt < this.ttlMs) return this.cached;
    this.cached = buildMenu(await this.square.listCatalog(), this.locationId);
    return this.cached;
  }

  async getStock(menu: Menu, variationIds?: string[]): Promise<Map<string, number>> {
    const ids = (variationIds ?? [...menu.byVariation.keys()]).filter((id) => menu.byVariation.get(id)?.variation.trackInventory);
    return this.square.inventoryCounts(ids, this.locationId);
  }
}
