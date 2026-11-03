import type { SquareApi, SquareCard } from "./square/client.js";
import type { Conversation, SavedCard } from "./store/types.js";

const LOOKUP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Names come from outside (Square profiles, customers' texts) and end up in the AI's instructions.
 * Keep letters, spaces, hyphens and apostrophes only, max 40 characters, so a name can't carry instructions.
 */
export function cleanName(raw: string | null | undefined): string | null {
  const s = (raw ?? "").replace(/[^\p{L}\p{M}' -]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, 40).trim();
  return s || null;
}

/** Matches a texting phone number to the seller's Square Customer Directory. */
export class CustomerService {
  constructor(
    private square: SquareApi,
    private now: () => Date,
    private log: (m: string, e?: unknown) => void = () => {},
  ) {}

  /**
   * Refreshes Square customer details on the conversation at most once a day.
   * Several profiles with the same phone: we can't tell who this is, so no name and no card features,
   * and we can never charge somebody else's card. Never throws.
   */
  async refresh(conv: Conversation, opts: { force?: boolean } = {}): Promise<void> {
    const last = conv.customerLookupAt ? new Date(conv.customerLookupAt).getTime() : 0;
    if (!opts.force && last && this.now().getTime() - last < LOOKUP_MAX_AGE_MS) return;
    try {
      const matches = await this.square.searchCustomersByPhone(conv.phone);
      conv.customerLookupAt = this.now();
      if (matches.length === 0) {
        conv.squareCustomerId = null;
        conv.customerAmbiguous = false;
        conv.savedCard = null;
        conv.savedCards = [];
        conv.loyaltyAccountId = null;
        return;
      }
      const best = matches[0]!;
      if (matches.length > 1) {
        conv.squareCustomerId = null;
        conv.customerAmbiguous = true;
        conv.savedCard = null;
        conv.savedCards = [];
        conv.loyaltyAccountId = null;
        return;
      }
      conv.squareCustomerId = best.id;
      conv.customerAmbiguous = false;
      if (!conv.customerName) conv.customerName = cleanName(best.given_name);
      conv.savedCards = distinctCards(await this.square.listCards(best.id));
      conv.savedCard = conv.savedCards[0] ?? null;
      const account = await this.square.searchLoyaltyAccount(best.id).catch(() => null);
      conv.loyaltyAccountId = account?.id ?? null;
      conv.loyaltyBalance = account?.balance ?? null;
    } catch (err) {
      this.log(`customer lookup failed for ${conv.phone}`, err);
    }
  }

  /** Makes sure this phone has a Square customer profile (reusing one if it appeared meanwhile). Returns its id. */
  async ensureProfile(conv: Conversation, idempotencyKey: string): Promise<string> {
    if (conv.squareCustomerId) return conv.squareCustomerId;
    const matches = await this.square.searchCustomersByPhone(conv.phone);
    if (matches.length === 1) {
      conv.squareCustomerId = matches[0]!.id;
      return matches[0]!.id;
    }
    if (matches.length > 1) {
      conv.customerAmbiguous = true;
      throw new Error("several Square customers share this phone number");
    }
    const created = await this.square.createCustomer({ idempotencyKey, givenName: conv.customerName ?? "Text customer", phone: conv.phone });
    conv.squareCustomerId = created.id;
    return created.id;
  }
}

const MAX_LISTED_CARDS = 3;

/** Saved cards newest first, one entry per physical card (by Square fingerprint), at most 3. */
export function distinctCards(cards: SquareCard[]): SavedCard[] {
  const sorted = [...cards].sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
  const byKey = new Map<string, SavedCard>();
  for (const c of sorted) {
    const key = c.fingerprint ?? `${c.card_brand}:${c.last_4}:${c.id}`;
    const seen = byKey.get(key);
    if (seen) seen.otherIds = [...(seen.otherIds ?? []), c.id];
    else byKey.set(key, { id: c.id, brand: c.card_brand ?? "Card", last4: c.last_4 ?? "????" });
  }
  return [...byKey.values()].slice(0, MAX_LISTED_CARDS);
}

export const cardLabel = (c: SavedCard) => `${c.brand} ••${c.last4}`;

/** One line for the AI's system prompt. */
export function customerPromptLine(conv: Conversation): string {
  const known = conv.squareCustomerId || conv.customerAmbiguous;
  if (!known) return "Square customer: no";
  const name = conv.customerName ? ` (given name ${JSON.stringify(conv.customerName)})` : "";
  const cards = conv.savedCards?.length ? conv.savedCards : conv.savedCard ? [conv.savedCard] : [];
  const card = cards.length ? cards.map(cardLabel).join(", ") : "none";
  return `Square customer: yes${name} · saved card: ${card}${conv.loyaltyAccountId ? " · loyalty member" : ""}`;
}
