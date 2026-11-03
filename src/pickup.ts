import type { FeedGame } from "./game/hockeytech.js";
import { ordinal } from "./game/service.js";
import type { Timeline } from "./game/timeline.js";
import type { PickupTarget } from "./store/types.js";

export type ResolvedPickup =
  | { ok: true; pickupAt: Date | null; slotKey: string; label: string }
  | { ok: false; reason: string };

/** Today's Lakers home game (null if none) and its current timeline. */
export interface GameToday {
  game: FeedGame | null;
  timeline: Timeline | null;
}

/** "3:43" style local time, as used in customer texts. */
export function shortTime(d: Date, tz: string): string {
  return d.toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true }).replace(/\s?[AP]M$/i, "");
}

/** Local wall-clock HH:MM today in `tz` → the matching instant. */
function todayAt(hhmm: string, now: Date, tz: string): Date | null {
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +m[1]!, +m[2]!);
  // Offset of tz at this moment: local wall time minus UTC.
  const offset = Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!) - Math.floor(now.getTime() / 60_000) * 60_000;
  return new Date(asUtc - offset);
}

const NO_GAME = "There's no Lakers home game today.";
const NO_CLOCK = "I can't see the game clock right now, so I can do right away or a time like 8:15.";

/** Turns what the customer asked for into a pickup time and a capacity slot. The AI never computes times. */
export function resolvePickup(t: PickupTarget, today: GameToday | null, gameUsable: boolean, now: Date, tz: string): ResolvedPickup {
  if (t.kind === "asap") return { ok: true, pickupAt: null, slotKey: "asap", label: "right away" };

  if (t.kind === "clock") {
    const at = todayAt(t.hhmm, now, tz);
    if (!at) return { ok: false, reason: "I didn't catch that time. Try something like 8:15." };
    if (at <= now) return { ok: false, reason: "That time has already passed. Want it right away?" };
    return { ok: true, pickupAt: at, slotKey: "clock", label: `about ${shortTime(at, tz)}` };
  }

  const game = today?.game;
  if (!game) return { ok: false, reason: NO_GAME };
  const tl = today?.timeline;
  if (!gameUsable || !tl?.trustworthy) return { ok: false, reason: NO_CLOCK };

  if (t.kind === "after_game") {
    if (!tl.gameEnd) return { ok: false, reason: NO_CLOCK };
    return { ok: true, pickupAt: tl.gameEnd, slotKey: `game:${game.id}:end`, label: "after the game" };
  }

  const n: 1 | 2 | null = t.kind === "intermission" ? t.n : tl.intermissionStarts[1] ? 1 : tl.intermissionStarts[2] ? 2 : null;
  if (n == null) return { ok: false, reason: "Both intermissions have started. Want it right away, or after the game?" };
  const at = tl.intermissionStarts[n];
  const label = `the ${ordinal(n)} intermission`;
  if (!at || at <= now) return { ok: false, reason: `The ${ordinal(n)} intermission has already started. Want it right away instead?` };
  return { ok: true, pickupAt: at, slotKey: `game:${game.id}:int${n}`, label };
}

const TARGETS: Record<string, PickupTarget> = {
  asap: { kind: "asap" },
  intermission_1: { kind: "intermission", n: 1 },
  intermission_2: { kind: "intermission", n: 2 },
  next_intermission: { kind: "next_intermission" },
  after_game: { kind: "after_game" },
};

/** The set_pickup_time tool's input → a PickupTarget (null if it doesn't make sense). */
export function targetFromTool(target: string, clock?: string): PickupTarget | null {
  if (target === "clock") return clock ? { kind: "clock", hhmm: clock.trim() } : null;
  return TARGETS[target] ?? null;
}
