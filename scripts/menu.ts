/** Prints the menu exactly as the AI will see it. Useful for checking your Square catalog setup.  npm run menu */
import { createSquareClient } from "../src/square/client.js";
import { MenuService, menuForModel } from "../src/square/menu.js";

const token = process.env.SQUARE_ACCESS_TOKEN;
const location = process.env.SQUARE_LOCATION_ID;
if (!token || !location) {
  console.error("Set SQUARE_ACCESS_TOKEN and SQUARE_LOCATION_ID (and SQUARE_ENV=production for live).");
  process.exit(1);
}
const square = createSquareClient({
  accessToken: token,
  env: process.env.SQUARE_ENV === "production" ? "production" : "sandbox",
  apiVersion: process.env.SQUARE_API_VERSION ?? "2026-09-16",
  locationId: location,
});
const menus = new MenuService(square, location);
const menu = await menus.getMenu(true);
console.log(menuForModel(menu, await menus.getStock(menu)));
