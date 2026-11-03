import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fetchScorebar, parseScorebar, type FeedGame } from "../src/game/hockeytech.js";
import { GameService } from "../src/game/service.js";
import { estimateTimeline } from "../src/game/timeline.js";
import { MemoryStore } from "../src/store/memory.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/hockeytech-scorebar-2026-11-03.json", import.meta.url), "utf8"));
const games = parseScorebar(fixture);
const lakersHome = games.find((g) => g.id === "4011")!; // Sun Nov 8, 3:15pm (-05:00) vs DID
const OPTS = { secondsPerClockMinute: 105, intermissionMinutes: 18, intermissionStartedAt: null };
const min = (n: number) => n * 60_000;
const at = (iso: string) => new Date(iso);

/** Fixture game 4011 with live fields overridden. */
function live(over: Record<string, string>): unknown {
  const copy = structuredClone(fixture);
  const g = copy.SiteKit.Scorebar.find((x: { ID: string }) => x.ID === "4011");
  Object.assign(g, over);
  return copy;
}

describe("HockeyTech scorebar", () => {
  it("parses the saved scorebar", () => {
    expect(games).toHaveLength(17);
    expect(lakersHome).toMatchObject({ id: "4011", homeId: "9", visitorCode: "DID", status: "scheduled", period: 1, venue: "Memorial Sports Centre" });
    expect(lakersHome.startsAt.toISOString()).toBe("2026-11-08T20:15:00.000Z");
    expect(games.find((g) => g.id === "4001")!.status).toBe("final");
  });

  it("maps live statuses, intermissions and the clock", () => {
    const g = (over: Record<string, string>) => parseScorebar(live(over)).find((x) => x.id === "4011")!;
    expect(g({ GameStatus: "2", Intermission: "0", Period: "2", GameClock: "06:00" })).toMatchObject({ status: "in_progress", period: 2, clockSeconds: 360 });
    expect(g({ GameStatus: "2", Intermission: "1", Period: "1", GameClock: "12:00" })).toMatchObject({ status: "intermission", period: 1 });
    expect(g({ GameStatus: "9", Intermission: "0" }).status).toBe("unknown");
  });

  it("fetches plain JSON from the feed and strips a JSONP wrapper", async () => {
    let url = "";
    const fetchImpl = (async (u: string) => {
      url = u;
      return new Response(`(${JSON.stringify(fixture)})`, { status: 200 });
    }) as unknown as typeof fetch;
    const out = await fetchScorebar({ key: "K", clientCode: "sijhl", fetchImpl });
    expect(out).toHaveLength(17);
    expect(url).toContain("https://lscluster.hockeytech.com/feed/index.php?");
    expect(url).toContain("feed=modulekit&view=scorebar&numberofdaysahead=1&numberofdaysback=0");
    expect(url).toContain("key=K&client_code=sijhl");
    expect(url).not.toContain("callback");
  });
});

describe("intermission timeline", () => {
  it("scheduled game: intermissions from puck drop", () => {
    const t = estimateTimeline(lakersHome, at("2026-11-08T18:00:00Z"), OPTS);
    const start = lakersHome.startsAt.getTime();
    expect(t.trustworthy).toBe(true);
    expect(t.intermissionStarts[1]!.getTime()).toBe(start + min(35));
    expect(t.intermissionStarts[2]!.getTime()).toBe(start + min(88));
    expect(t.gameEnd!.getTime()).toBe(start + min(141));
  });

  it("live game re-estimates from the clock", () => {
    const g: FeedGame = { ...lakersHome, status: "in_progress", period: 2, clockSeconds: 360 };
    const now = at("2026-11-09T01:05:00Z"); // 8:05pm local
    const t = estimateTimeline(g, now, OPTS);
    expect(t.intermissionStarts[1]).toBeNull(); // already happened
    expect(t.intermissionStarts[2]!.toISOString()).toBe("2026-11-09T01:15:30.000Z");
    expect(t.gameEnd!.getTime()).toBe(at("2026-11-09T01:15:30Z").getTime() + min(18 + 35));
  });

  it("during the 1st intermission, the 2nd is counted from when the break started", () => {
    const g: FeedGame = { ...lakersHome, status: "intermission", period: 1, clockSeconds: 0 };
    const started = at("2026-11-08T20:50:00Z");
    const t = estimateTimeline(g, at("2026-11-08T20:55:00Z"), { ...OPTS, intermissionStartedAt: started });
    expect(t.intermissionStarts[1]).toBeNull();
    expect(t.intermissionStarts[2]!.getTime()).toBe(started.getTime() + min(18 + 35));
  });

  it("overtime or unknown status is not trustworthy", () => {
    expect(estimateTimeline({ ...lakersHome, status: "in_progress", period: 4, clockSeconds: 200 }, new Date(), OPTS).trustworthy).toBe(false);
    expect(estimateTimeline({ ...lakersHome, status: "unknown" }, new Date(), OPTS).trustworthy).toBe(false);
  });
});

function gameService(o: { store?: MemoryStore; fetchGames: () => Promise<FeedGame[]>; clock: { now: Date } }) {
  const alerts: string[] = [];
  const changes: number[] = [];
  const svc = new GameService({
    fetchGames: o.fetchGames,
    store: o.store ?? new MemoryStore(),
    teamId: "9",
    tz: "Etc/GMT+5",
    now: () => o.clock.now,
    secondsPerClockMinute: 105,
    intermissionMinutes: 18,
    notifyOwner: async (t) => {
      alerts.push(t);
    },
    onTimelineChange: async () => {
      changes.push(1);
    },
    log: () => {},
  });
  return { svc, alerts, changes };
}

describe("game service", () => {
  it("no Lakers home game today", async () => {
    const clock = { now: at("2026-11-03T17:00:00Z") }; // Nov 3: Lakers are away at Red Lake
    const { svc } = gameService({ fetchGames: async () => games, clock });
    await svc.tick();
    expect(svc.homeGameToday()).toBeNull();
    expect(svc.usable()).toBe(false);
  });

  it("finds today's home game and describes it", async () => {
    const clock = { now: at("2026-11-08T18:00:00Z") }; // noon local, game day
    const { svc } = gameService({ fetchGames: async () => games, clock });
    await svc.tick();
    expect(svc.homeGameToday()?.id).toBe("4011");
    expect(svc.usable()).toBe(true);
    expect(svc.describe("Etc/GMT+5")).toBe("Lakers vs DID 3:15pm · not started · int1 ≈ 3:50pm · int2 ≈ 4:43pm · end ≈ 5:36pm");
  });

  it("polls only in the live window", async () => {
    let calls = 0;
    const clock = { now: at("2026-11-08T18:00:00Z") }; // 1:00pm local
    const { svc } = gameService({ fetchGames: async () => (calls++, games), clock });
    await svc.tick();
    clock.now = at("2026-11-08T18:00:30Z");
    await svc.tick();
    expect(calls).toBe(1); // hourly refresh only

    clock.now = at("2026-11-08T19:50:00Z"); // 2:50pm, 25 min before puck drop
    await svc.tick();
    clock.now = at("2026-11-08T19:50:30Z");
    await svc.tick();
    expect(calls).toBe(3);
  });

  it("feed failure turns game timing off and alerts once", async () => {
    let fail = false;
    const clock = { now: at("2026-11-08T19:50:00Z") };
    const { svc, alerts } = gameService({
      fetchGames: async () => {
        if (fail) throw new Error("feed down");
        return games;
      },
      clock,
    });
    await svc.tick();
    expect(svc.usable()).toBe(true);
    fail = true;
    clock.now = at("2026-11-08T19:50:30Z");
    await svc.tick();
    clock.now = at("2026-11-08T19:51:00Z");
    await svc.tick();
    expect(svc.usable()).toBe(false);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatch(/game clock/i);
  });

  it("an unknown status turns timing off and alerts once", async () => {
    const clock = { now: at("2026-11-08T20:30:00Z") };
    const weird = parseScorebar(live({ GameStatus: "9", Intermission: "0" }));
    const { svc, alerts } = gameService({ fetchGames: async () => weird, clock });
    await svc.tick();
    clock.now = at("2026-11-08T20:30:30Z");
    await svc.tick();
    expect(svc.usable()).toBe(false);
    expect(alerts).toHaveLength(1);
  });

  it("a non-numeric period (OT, SO) is not trustworthy and alerts once", async () => {
    const clock = { now: at("2026-11-08T22:40:00Z") };
    const ot = parseScorebar(live({ GameStatus: "2", Intermission: "0", Period: "OT", GameClock: "03:00" }));
    const { svc, alerts } = gameService({ fetchGames: async () => ot, clock });
    await svc.tick();
    clock.now = at("2026-11-08T22:40:30Z");
    await svc.tick();
    expect(svc.state()!.timeline!.trustworthy).toBe(false);
    expect(svc.usable()).toBe(false);
    expect(alerts).toHaveLength(1);
  });

  it("remembers when an intermission started", async () => {
    const clock = { now: at("2026-11-08T20:50:00Z") };
    let feed = parseScorebar(live({ GameStatus: "2", Intermission: "1", Period: "1", GameClock: "00:00" }));
    const { svc } = gameService({ fetchGames: async () => feed, clock });
    await svc.tick();
    clock.now = at("2026-11-08T20:55:00Z");
    await svc.tick();
    expect(svc.state()!.intermissionStartedAt!.toISOString()).toBe("2026-11-08T20:50:00.000Z");
    expect(svc.state()!.timeline!.intermissionStarts[2]!.toISOString()).toBe("2026-11-08T21:43:00.000Z");
    feed = parseScorebar(live({ GameStatus: "2", Intermission: "0", Period: "2", GameClock: "19:00" }));
    clock.now = at("2026-11-08T21:09:00Z");
    await svc.tick();
    expect(svc.state()!.intermissionStartedAt).toBeNull();
  });

  it("tells the order code when the timeline changes", async () => {
    const clock = { now: at("2026-11-08T20:30:00Z") };
    let feed = parseScorebar(live({ GameStatus: "2", Intermission: "0", Period: "1", GameClock: "10:00" }));
    const { svc, changes } = gameService({ fetchGames: async () => feed, clock });
    await svc.tick();
    expect(changes).toHaveLength(1);
    feed = parseScorebar(live({ GameStatus: "2", Intermission: "0", Period: "1", GameClock: "09:30" }));
    clock.now = at("2026-11-08T20:30:30Z");
    await svc.tick();
    expect(changes).toHaveLength(2);
  });

  it("restores state after restart", async () => {
    const store = new MemoryStore();
    const clock = { now: at("2026-11-08T20:30:00Z") };
    const feed = parseScorebar(live({ GameStatus: "2", Intermission: "0", Period: "2", GameClock: "06:00" }));
    const first = gameService({ store, fetchGames: async () => feed, clock });
    await first.svc.tick();
    const before = first.svc.state()!.timeline;

    const second = gameService({ store, fetchGames: async () => { throw new Error("not called"); }, clock });
    await second.svc.load();
    expect(second.svc.state()!.timeline).toEqual(before);
    expect(second.svc.usable()).toBe(true);
  });
});
