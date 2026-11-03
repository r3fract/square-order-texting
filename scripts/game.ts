/** Shows what the game poller sees on the HockeyTech feed right now.  npx tsx --env-file=.env scripts/game.ts */
import { fetchScorebar } from "../src/game/hockeytech.js";
import { GameService } from "../src/game/service.js";
import { MemoryStore } from "../src/store/memory.js";

const { HOCKEYTECH_KEY: key, HOCKEYTECH_CLIENT_CODE: clientCode, HOCKEYTECH_TEAM_ID: teamId, TIMEZONE: tz = "Etc/GMT+5" } = process.env;
if (!key || !clientCode || !teamId) {
  console.error("Set HOCKEYTECH_KEY, HOCKEYTECH_CLIENT_CODE and HOCKEYTECH_TEAM_ID.");
  process.exit(1);
}
const games = await fetchScorebar({ key, clientCode });
for (const g of games) console.log(`${g.id} ${g.startsAt.toISOString()} ${g.visitorCode}@home${g.homeId} ${g.status} P${g.period}`);
const svc = new GameService({
  fetchGames: async () => games, store: new MemoryStore(), teamId, tz, now: () => new Date(),
  secondsPerClockMinute: Number(process.env.GAME_SECONDS_PER_CLOCK_MINUTE ?? 105),
  intermissionMinutes: Number(process.env.GAME_INTERMISSION_MINUTES ?? 18),
  notifyOwner: async (t) => console.log("owner alert:", t), onTimelineChange: async () => {}, log: console.log,
});
await svc.tick();
console.log("\nToday:", svc.describe(tz));
