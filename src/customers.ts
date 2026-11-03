import type { SquareApi, SquareCustomer } from "./square/client.js";
import type { Conversation } from "./store/types.js";

const LOOKUP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const newest = (cs: SquareCustomer[]) => [...cs].sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""))[0];

/** Matches a texting phone number to the seller's Square Customer Directory. */
export class CustomerService {
  constructor(
    private square: SquareApi,
    private now: () => Date,
    private log: (m: string, e?: unknown) => void = () => {},
  ) {}

  /**
   * Refreshes Square customer details on the conversation at most once a day.
   * Several profiles with the same phone: greet with the newest name but turn card features off,
   * so we can never charge somebody else's card. Never throws.
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
        conv.loyaltyAccountId = null;
        return;
      }
      const best = newest(matches)!;
      if (!conv.customerName && best.given_name) conv.customerName = best.given_name;
      if (matches.length > 1) {
        conv.squareCustomerId = null;
        conv.customerAmbiguous = true;
        conv.savedCard = null;
        conv.loyaltyAccountId = null;
        return;
      }
      conv.squareCustomerId = best.id;
      conv.customerAmbiguous = false;
      const card = (await this.square.listCards(best.id))[0];
      conv.savedCard = card ? { id: card.id, brand: card.card_brand ?? "Card", last4: card.last_4 ?? "????" } : null;
      const account = await this.square.searchLoyaltyAccount(best.id).catch(() => null);
      conv.loyaltyAccountId = account?.id ?? null;
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

/** One line for the AI's system prompt. */
export function customerPromptLine(conv: Conversation): string {
  const known = conv.squareCustomerId || conv.customerAmbiguous;
  if (!known) return "Square customer: no";
  const name = conv.customerName ? ` (given name ${conv.customerName})` : "";
  const card = conv.savedCard ? `${conv.savedCard.brand} ••${conv.savedCard.last4}` : "none";
  return `Square customer: yes${name} · saved card: ${card}${conv.loyaltyAccountId ? " · loyalty member" : ""}`;
}
