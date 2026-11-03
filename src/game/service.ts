import type { Store } from "../store/types.js";
import type { FeedGame } from "./hockeytech.js";
import { estimateTimeline, sameTimeline, type Timeline } from "./timeline.js";

export interface GameState {
  game: FeedGame | null;
  timeline: Timeline | null;
  feedOk: boolean;
  checkedAt: Date;
  intermissionStartedAt: Date | null;
  alertedGameId: string | null;
}

const SETTING = "game_state";
const HOURLY = 60 * 60_000;
const LIVE_LEAD = 30 * 60_000; // start polling this long before puck drop
const LIVE_MAX = 5 * 60 * 60_000; // stop polling this long after puck drop even if "final" never shows

export interface GameServiceDeps {
  fetchGames: () => Promise<FeedGame[]>;
  store: Store;
  teamId: string | null;
  tz: string;
  now: () => Date;
  secondsPerClockMinute: number;
  intermissionMinutes: number;
  notifyOwner: (t: string) => Promise<void>;
  onTimelineChange: (prev: Timeline | null, next: Timeline) => Promise<void>;
  log: (m: string, e?: unknown) => void;
}

const localDate = (d: Date, tz: string) => d.toLocaleDateString("en-CA", { timeZone: tz });
const hm = (d: Date, tz: string) =>
  d.toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).replace(" ", "").replace(":00", "").toLowerCase();

function revive(raw: any): GameState {
  const d = (v: string | null) => (v ? new Date(v) : null);
  const game = raw.game ? { ...raw.game, startsAt: new Date(raw.game.startsAt) } : null;
  const timeline = raw.timeline
    ? {
        ...raw.timeline,
        intermissionStarts: { 1: d(raw.timeline.intermissionStarts["1"]), 2: d(raw.timeline.intermissionStarts["2"]) },
        gameEnd: d(raw.timeline.gameEnd),
      }
    : null;
  return { ...raw, game, timeline, checkedAt: new Date(raw.checkedAt), intermissionStartedAt: d(raw.intermissionStartedAt) };
}

/** Follows today's Lakers home game on the HockeyTech feed and keeps an intermission timeline. */
export class GameService {
  private s: GameState | null = null;
  private lastRefresh = 0;

  constructor(private d: GameServiceDeps) {}

  async load(): Promise<void> {
    const raw = await this.d.store.getSetting(SETTING);
    if (raw) {
      try {
        this.s = revive(JSON.parse(raw));
      } catch (err) {
        this.d.log("couldn't restore game state", err);
      }
    }
  }

  state(): GameState | null {
    return this.s;
  }

  homeGameToday(): FeedGame | null {
    const g = this.s?.game;
    if (!g || g.homeId !== this.d.teamId) return null;
    return localDate(g.startsAt, this.d.tz) === localDate(this.d.now(), this.d.tz) ? g : null;
  }

  usable(): boolean {
    const g = this.homeGameToday();
    return !!(g && this.s?.feedOk && this.s.timeline?.trustworthy && g.status !== "final");
  }

  private inLiveWindow(now: Date): boolean {
    const g = this.homeGameToday();
    if (!g || g.status === "final") return false;
    const t = now.getTime() - g.startsAt.getTime();
    return t >= -LIVE_LEAD && t <= LIVE_MAX;
  }

  async tick(): Promise<void> {
    if (!this.d.teamId) return;
    const now = this.d.now();
    const due = now.getTime() - this.lastRefresh >= HOURLY || this.inLiveWindow(now);
    if (!due) return;
    this.lastRefresh = now.getTime();

    const prev = this.s;
    let games: FeedGame[];
    try {
      games = await this.d.fetchGames();
    } catch (err) {
      this.d.log("game feed failed", err);
      if (prev) {
        this.s = { ...prev, feedOk: false, checkedAt: now };
        await this.alertOnce("⚠️ Can't read the Lakers game clock right now, so intermission pickups are off. Customers can still order for right away or a set time.");
        await this.persist();
      }
      return;
    }

    const today = localDate(now, this.d.tz);
    const game =
      games.find((g) => g.homeId === this.d.teamId && localDate(g.startsAt, this.d.tz) === today) ??
      games.find((g) => g.homeId === this.d.teamId && g.startsAt > now) ??
      null;

    let intermissionStartedAt = prev?.game?.id === game?.id ? (prev?.intermissionStartedAt ?? null) : null;
    if (game?.status === "intermission") intermissionStartedAt ??= now;
    else intermissionStartedAt = null;

    const timeline = game
      ? estimateTimeline(game, now, {
          secondsPerClockMinute: this.d.secondsPerClockMinute,
          intermissionMinutes: this.d.intermissionMinutes,
          intermissionStartedAt,
        })
      : null;

    this.s = {
      game,
      timeline,
      feedOk: true,
      checkedAt: now,
      intermissionStartedAt,
      alertedGameId: prev?.game?.id === game?.id ? (prev?.alertedGameId ?? null) : null,
    };
    if (game && game.status === "unknown") {
      await this.alertOnce("⚠️ The Lakers game clock shows a state I don't recognize, so intermission pickups are off for now.");
    }
    await this.persist();

    if (timeline && !sameTimeline(prev?.timeline ?? null, timeline)) {
      await this.d.onTimelineChange(prev?.timeline ?? null, timeline).catch((err) => this.d.log("timeline change handler failed", err));
    }
  }

  private async alertOnce(text: string) {
    const id = this.s?.game?.id ?? "none";
    if (!this.s || this.s.alertedGameId === id) return;
    this.s.alertedGameId = id;
    await this.d.notifyOwner(text).catch(() => {});
  }

  private async persist() {
    await this.d.store.setSetting(SETTING, JSON.stringify(this.s));
  }

  /** Short summary for STATUS / GAME texts and the AI's prompt. */
  describe(tz: string): string {
    const g = this.homeGameToday();
    if (!g) return "No Lakers home game today.";
    if (!this.s?.feedOk) return `Lakers vs ${g.visitorCode} ${hm(g.startsAt, tz)} · game clock unavailable`;
    const where =
      g.status === "scheduled"
        ? "not started"
        : g.status === "in_progress"
          ? `${ordinal(g.period)}, ${fmtClock(g.clockSeconds)} left`
          : g.status === "intermission"
            ? `${ordinal(g.period)} intermission`
            : g.status === "final"
              ? "final"
              : "status unclear";
    const t = this.s.timeline;
    const parts = [`Lakers vs ${g.visitorCode} ${hm(g.startsAt, tz)}`, where];
    if (t?.trustworthy) {
      if (t.intermissionStarts[1]) parts.push(`int1 ≈ ${hm(t.intermissionStarts[1], tz)}`);
      if (t.intermissionStarts[2]) parts.push(`int2 ≈ ${hm(t.intermissionStarts[2], tz)}`);
      if (t.gameEnd) parts.push(`end ≈ ${hm(t.gameEnd, tz)}`);
    }
    return parts.join(" · ");
  }
}

export function ordinal(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n}${s}`;
}

function fmtClock(sec: number | null): string {
  if (sec == null) return "?";
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}
