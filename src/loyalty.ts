import type { LoyaltyProgram, SquareApi } from "./square/client.js";
import type { OrderRecord } from "./store/types.js";

const PROGRAM_TTL_MS = 60 * 60_000;

/** Square Loyalty, if the seller uses it. Never enrols anyone: only existing members earn and redeem. */
export class LoyaltyService {
  private cached: { program: LoyaltyProgram | null; at: number } | null = null;

  constructor(
    private square: SquareApi,
    private locationId: string,
    private log: (m: string, e?: unknown) => void = () => {},
  ) {}

  async program(): Promise<LoyaltyProgram | null> {
    if (this.cached && Date.now() - this.cached.at < PROGRAM_TTL_MS) return this.cached.program;
    try {
      const program = await this.square.retrieveLoyaltyProgram();
      this.cached = { program, at: Date.now() };
      return program;
    } catch (err) {
      this.log("couldn't load the loyalty program", err);
      return this.cached?.program ?? null;
    }
  }

  /** The best reward tier the balance covers, if any. */
  async affordableTier(balance: number): Promise<{ id: string; name: string; points: number } | null> {
    const p = await this.program();
    const tiers = (p?.reward_tiers ?? []).filter((t) => t.points <= balance).sort((a, b) => b.points - a.points);
    return tiers[0] ?? null;
  }

  /** Adds points for a picked-up order. Square's program rules decide how many. Errors are logged, never thrown. */
  async accumulate(order: OrderRecord, accountId: string): Promise<void> {
    if (!(await this.program())) return;
    try {
      await this.square.accumulateLoyalty({ accountId, orderId: order.squareOrderId, locationId: this.locationId, idempotencyKey: `loyalty:${order.id}` });
    } catch (err) {
      this.log(`couldn't add loyalty points for order #${order.orderNumber}`, err);
    }
  }
}
