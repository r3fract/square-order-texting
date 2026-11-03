import type { Day, OrderingHours } from "./config.js";
import type { BusinessHoursPeriod, SquareApi } from "./square/client.js";

const DAY_OF_WEEK: Record<string, Day> = { SUN: "sun", MON: "mon", TUE: "tue", WED: "wed", THU: "thu", FRI: "fri", SAT: "sat" };

const minutes = (hhmmss: string) => {
  const [h, m] = hhmmss.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/**
 * Square location business hours → ordering hours. Null when Square has none (which means closed).
 * Our call: if a day has several periods, ordering runs from the earliest open to the latest close.
 *
 * Item-level hours: Square's Catalog API has AVAILABILITY_PERIOD objects, but in this sandbox's catalog (checked
 * 2026-11-03) no item references one, so per-item hours aren't applied. Revisit if the seller starts using them.
 */
export function hoursFromBusinessHours(periods: BusinessHoursPeriod[] | undefined): OrderingHours {
  const out: Partial<Record<Day, { open: number; close: number }>> = {};
  for (const p of periods ?? []) {
    const day = DAY_OF_WEEK[p.day_of_week?.toUpperCase()];
    if (!day) continue;
    const open = minutes(p.start_local_time);
    const close = minutes(p.end_local_time);
    const cur = out[day];
    out[day] = cur ? { open: Math.min(cur.open, open), close: Math.max(cur.close, close) } : { open, close };
  }
  return Object.keys(out).length ? out : null;
}

/** Ordering hours: the ORDERING_HOURS override if set, otherwise Square's business hours (cached). */
export class HoursService {
  private cached: { hours: OrderingHours; at: number } | null = null;
  private lastGood: OrderingHours = null;

  constructor(
    private square: SquareApi,
    private override: OrderingHours,
    private ttlMs = 15 * 60_000,
  ) {}

  /** True once hours have been read (from the override or Square at least once). */
  isKnown(): boolean {
    return !!this.override || this.cached !== null;
  }

  /** Last known hours without calling Square (for synchronous checks). */
  peek(): OrderingHours {
    return this.override ?? this.lastGood;
  }

  async current(): Promise<OrderingHours> {
    if (this.override) return this.override;
    if (this.cached && Date.now() - this.cached.at < this.ttlMs) return this.cached.hours;
    try {
      const loc = await this.square.retrieveLocation();
      const hours = hoursFromBusinessHours(loc.business_hours?.periods);
      this.cached = { hours, at: Date.now() };
      this.lastGood = hours;
      return hours;
    } catch {
      return this.lastGood; // Square hiccup: keep the last hours we knew (null = closed if we never knew any)
    }
  }
}
