import type { FeedGame } from "./hockeytech.js";

export interface Timeline {
  gameId: string;
  /** When intermission 1 / 2 starts (end of period 1 / 2). Null once it has started or is unknown. */
  intermissionStarts: { 1: Date | null; 2: Date | null };
  gameEnd: Date | null;
  trustworthy: boolean;
}

const CLOCK_MINUTES_PER_PERIOD = 20;

/**
 * Estimates intermission times from the live game state. A period is 20 clock minutes; stoppages make each clock
 * minute take about `secondsPerClockMinute` real seconds. Overtime, shootouts and unknown states are not trustworthy.
 */
export function estimateTimeline(
  g: FeedGame,
  now: Date,
  o: { secondsPerClockMinute: number; intermissionMinutes: number; intermissionStartedAt: Date | null },
): Timeline {
  const P = CLOCK_MINUTES_PER_PERIOD * o.secondsPerClockMinute * 1000;
  const I = o.intermissionMinutes * 60_000;
  const none: Timeline = { gameId: g.id, intermissionStarts: { 1: null, 2: null }, gameEnd: null, trustworthy: false };
  const t = (ms: number) => new Date(ms);

  if (g.status === "unknown" || g.status === "final") return none;
  // Overtime, shootouts and anything that isn't period 1-3 ("OT", "SO" parse as 0): not trustworthy.
  if (g.status !== "scheduled" && (g.period < 1 || g.period > 3)) return none;

  if (g.status === "scheduled") {
    const e1 = g.startsAt.getTime() + P;
    const e2 = e1 + I + P;
    return { gameId: g.id, intermissionStarts: { 1: t(e1), 2: t(e2) }, gameEnd: t(e2 + I + P), trustworthy: true };
  }

  if (g.status === "in_progress") {
    if (g.clockSeconds == null) return none;
    const periodEnd = now.getTime() + (g.clockSeconds / 60) * o.secondsPerClockMinute * 1000;
    if (g.period === 1) {
      const e2 = periodEnd + I + P;
      return { gameId: g.id, intermissionStarts: { 1: t(periodEnd), 2: t(e2) }, gameEnd: t(e2 + I + P), trustworthy: true };
    }
    if (g.period === 2) {
      return { gameId: g.id, intermissionStarts: { 1: null, 2: t(periodEnd) }, gameEnd: t(periodEnd + I + P), trustworthy: true };
    }
    return { gameId: g.id, intermissionStarts: { 1: null, 2: null }, gameEnd: t(periodEnd), trustworthy: true };
  }

  // Intermission after period g.period. After the 3rd it means overtime is coming: not trustworthy.
  const nextStart = (o.intermissionStartedAt ?? now).getTime() + I;
  if (g.period === 1) {
    const e2 = nextStart + P;
    return { gameId: g.id, intermissionStarts: { 1: null, 2: t(e2) }, gameEnd: t(e2 + I + P), trustworthy: true };
  }
  if (g.period === 2) {
    return { gameId: g.id, intermissionStarts: { 1: null, 2: null }, gameEnd: t(nextStart + P), trustworthy: true };
  }
  return none;
}

export function sameTimeline(a: Timeline | null, b: Timeline | null): boolean {
  if (!a || !b) return a === b;
  const ms = (d: Date | null) => d?.getTime() ?? null;
  return (
    a.gameId === b.gameId &&
    a.trustworthy === b.trustworthy &&
    ms(a.intermissionStarts[1]) === ms(b.intermissionStarts[1]) &&
    ms(a.intermissionStarts[2]) === ms(b.intermissionStarts[2]) &&
    ms(a.gameEnd) === ms(b.gameEnd)
  );
}
