import { createAnthropicModel } from "./anthropic.js";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { TextOrderService } from "./service.js";
import { createTwilioSender } from "./sms.js";
import { createSquareClient } from "./square/client.js";
import { MemoryStore } from "./store/memory.js";
import { PostgresStore } from "./store/postgres.js";
import type { Store } from "./store/types.js";

async function main() {
  const config = loadConfig();

  let store: Store;
  if (config.DATABASE_URL) {
    const pg = new PostgresStore(config.DATABASE_URL, config.TIMEZONE);
    await pg.migrate();
    store = pg;
  } else {
    console.warn("DATABASE_URL not set: using in-memory storage. Everything is lost on restart. Don't run real orders like this.");
    store = new MemoryStore();
  }

  const square = createSquareClient({
    accessToken: config.SQUARE_ACCESS_TOKEN,
    env: config.SQUARE_ENV,
    apiVersion: config.SQUARE_API_VERSION,
    locationId: config.SQUARE_LOCATION_ID,
  });
  const sms = createTwilioSender({
    accountSid: config.TWILIO_ACCOUNT_SID,
    authToken: config.TWILIO_AUTH_TOKEN,
    from: config.TWILIO_FROM_NUMBER,
  });
  const model = createAnthropicModel(config.ANTHROPIC_API_KEY);
  const service = new TextOrderService({ config, store, square, sms, model });

  // Fail fast if the Square token or location is wrong.
  const menu = await service.menus.getMenu(true);
  console.log(`Loaded ${menu.items.length} menu items from Square (${config.SQUARE_ENV}).`);

  if (!(await service.hours())) {
    const msg = "⚠️ Text ordering is closed: no business hours are set in Square. Set them in Square Dashboard → Locations.";
    console.warn(msg);
    await sms.send(config.OWNER_PHONE, msg).catch((err) => console.error("couldn't text owner", err));
  }

  if (service.game) {
    await service.game.load();
    await service.game.tick().catch((err) => console.error("game tick failed", err));
    console.log(`Game feed on: ${service.game.describe(config.TIMEZONE)}`);
  } else {
    console.log("Game feed off (set HOCKEYTECH_KEY, HOCKEYTECH_CLIENT_CODE, HOCKEYTECH_TEAM_ID to turn it on).");
  }
  const gameTimer = setInterval(() => {
    service.game?.tick().catch((err) => console.error("game tick failed", err));
  }, 30_000);

  const sweeper = setInterval(() => {
    service.expireStaleLinks().catch((err) => console.error("expire sweep failed", err));
  }, 60_000);

  const app = buildApp({ config, service, store });
  await app.listen({ port: config.PORT, host: "0.0.0.0" });

  const shutdown = async () => {
    clearInterval(sweeper);
    clearInterval(gameTimer);
    await app.close();
    if (store instanceof PostgresStore) await store.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
