/**
 * Talk to the ordering AI in your terminal, using your real Square (sandbox or production) and Claude,
 * without Twilio. Texts that would go out by SMS are printed instead.
 *
 *   npm run chat
 *
 * Commands:  /paid   pretend Square reported payment for the latest link
 *            /ready  pretend staff marked it ready
 *            /reset  forget this chat
 *            /quit
 */
import { createInterface } from "node:readline/promises";
import { createAnthropicModel } from "../src/anthropic.js";
import { loadConfig } from "../src/config.js";
import { TextOrderService } from "../src/service.js";
import { createSquareClient } from "../src/square/client.js";
import { MemoryStore } from "../src/store/memory.js";

const PHONE = "+18075551234";
const env = {
  PUBLIC_BASE_URL: "http://localhost",
  OWNER_PHONE: "+18075550100",
  TWILIO_ACCOUNT_SID: "unused",
  TWILIO_AUTH_TOKEN: "unused",
  TWILIO_FROM_NUMBER: "+10000000000",
  SQUARE_WEBHOOK_SIGNATURE_KEY: "unused",
  ADMIN_TOKEN: "unused-unused-unused",
  ...process.env,
};
const config = loadConfig(env);
const store = new MemoryStore();
const square = createSquareClient({ accessToken: config.SQUARE_ACCESS_TOKEN, env: config.SQUARE_ENV, apiVersion: config.SQUARE_API_VERSION });
const service = new TextOrderService({
  config,
  store,
  square,
  model: createAnthropicModel(config.ANTHROPIC_API_KEY),
  sms: {
    async send(to, body) {
      const who = to === config.OWNER_PHONE ? "→ to OWNER" : "→ to you";
      console.log(`\n\x1b[32m${who}:\x1b[0m\n${body}\n`);
    },
  },
  log: (m, e) => console.error(m, e),
});

const menu = await service.menus.getMenu(true);
console.log(`${config.BUSINESS_NAME}: ${menu.items.length} items loaded from Square ${config.SQUARE_ENV}. Text like a customer.\n`);

const rl = createInterface({ input: process.stdin, output: process.stdout });
let n = 0;
for (;;) {
  const line = (await rl.question("you> ")).trim();
  if (!line) continue;
  if (line === "/quit") break;
  const latest = (await store.listOrders(1))[0];
  if (line === "/reset") {
    store.conversations.delete(PHONE);
    console.log("(chat forgotten)");
    continue;
  }
  if (line === "/paid" || line === "/ready") {
    if (!latest) {
      console.log("(no order yet)");
      continue;
    }
    await service.handleSquareEvent(
      line === "/paid"
        ? { event_id: `local${++n}`, type: "payment.updated", data: { object: { payment: { status: "COMPLETED", order_id: latest.squareOrderId } } } }
        : { event_id: `local${++n}`, type: "order.fulfillment.updated", data: { object: { order_fulfillment_updated: { order_id: latest.squareOrderId, fulfillment_update: [{ new_state: "PREPARED" }] } } } },
    );
    continue;
  }
  await service.handleInboundSms({ from: PHONE, body: line, messageSid: `local${++n}` });
}
rl.close();
process.exit(0);
