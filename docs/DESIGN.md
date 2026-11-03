# Game-night text ordering: design

Date: 2026-11-03 · Status: implemented

## Why

The canteen serves Fort Frances Lakers (SIJHL) home games. The target moment: a fan is in their seat, the period is winding down, and they don't want to miss any of the game. They text an order. When the buzzer goes they walk to the canteen and pick up food that is already done, or their phone tells them exactly when it's ready. No line, no waiting, no missed faceoff.

Success: ordering by text becomes the main way people order at the canteen. It has to be faster and easier than walking up, especially for regulars.

## Goals

1. **Real hours only.** Text ordering is open only when Square's business hours say the business is open. A game does **not** open ordering. Nothing set means closed. *(Owner's decision.)*
2. **Recognize Square customers** by phone number and address them by name.
3. **One-word pay for regulars.** A customer with a card saved in Square confirms with "Y" and is charged. No link.
4. **Easy card saving** through a Square-hosted page. We never handle card details.
5. **Food timed to the game.** "End of 2nd" means the order hits the kitchen screen so it's done at the intermission, not right away.
6. **Know exactly when it's ready**: a queue position and estimated time when paid, then the existing "ready" text.
7. **Fewer texts for regulars**: "the usual" reorders, and loyalty points and rewards if the business uses Square Loyalty.

## Non-goals

- Seat delivery.
- Our own card-entry form (Square's hosted pages only).
- Scraping the SIJHL or Lakers HTML pages. The HockeyTech JSON feed (section 5) is the data source.
- Manual period updates by staff. *(Owner's decision: the live feed only.)*
- Multiple locations or teams.

## Anti-goals (failure even if it "works")

- Charging a card without an explicit yes for that specific order and total.
- Ordering by text being slower or more confusing than walking to the window.
- Food that's ready too early (cold) or too late (fan misses the next period).
- Spamming customers: no marketing texts, only texts about their own order.

## Constraints

- Existing TypeScript / Fastify / Postgres app ([src/](../src/)). Square REST client in [src/square/client.ts](../src/square/client.ts), pinned `SQUARE_API_VERSION`.
- SMS only (Twilio). Canada, CAD. Square sandbox now, production later.
- Single app instance (in-memory per-customer locks).
- Prices, totals and payments come from Square, never the AI. This existing guarantee must hold for every new path, including one-word pay.

## How it works

### 1. Hours from Square

- Ordering hours come from the Square location's `business_hours`, loaded with the menu and refreshed on the same schedule.
- `ORDERING_HOURS` in `.env` becomes an optional override. If Square has no hours and there's no override, ordering is **closed**, and the owner gets one warning text at startup. *(Our call.)*
- Item-level hours: if Square catalog items carry availability periods (`AVAILABILITY_PERIOD` objects) that the API exposes, items outside their window are treated like sold-out items. The builder checks whether the Catalog API links these to items. If it doesn't, skip this.
- Existing behaviour stays: closing time cancels unpaid links, and the "opens at …" message is built from the active hours.

### 2. Recognized customers

- When a phone number texts for the first time (or the cached lookup is older than a day), call Square `SearchCustomers` with an exact phone-number match. Store `squareCustomerId` and the given name on the conversation.
- The system prompt gets the customer's given name, whether they have a saved card (brand and last 4), loyalty balance if any, and their last paid order.
- Unknown numbers: after their first paid order, create a Square customer profile with the name they gave and their phone number, so they're recognized next time. *(Our call.)*
- Every Square order created by the app sets `customer_id` when known.

### 3. One-word pay (card on file)

- If the customer has an enabled card on file (`ListCards` by customer), the bot's read-back ends with: "Total $8.75. Pay with Visa ••1111? Reply Y." This replaces the link.
- On Y: create the Square order (`CreateOrder`, same line items and fulfillment as the payment-link path), then `CreatePayment` with `source_id` set to the card id, plus `customer_id`, `order_id`, the amount taken from **Square's order total**, and an idempotency key tied to the order. A completed payment goes through the existing `onPaid` path, which already ignores duplicates, so the `payment.updated` webhook and the direct response can't double-process.
- Safety rules:
  - Y is accepted only if the cart is unchanged since the read-back, and only within 10 minutes of it.
  - One-word pay is capped at `ONE_TAP_MAX_CENTS` (default $60). Above that, the customer gets a link.
  - A declined card gets a polite text and a payment link as a fallback.
  - "Forget my card" disables the card (`DisableCard`).
- The AI can't charge anything by itself. A new `pay_with_saved_card` tool only works when the code-side conditions above hold, the same way `send_checkout_link` is guarded today.

### 4. Saving a card (Square-hosted)

- Square invoices have a `store_payment_method_enabled` option, which adds a "Save my card on file" checkbox to Square's own invoice payment page.
- A recognized customer with no saved card, or a new customer after their first order, is offered once: "Want one-word ordering next time? I'll send a Square page where you can tick 'save my card'."
- If they say yes, that order is checked out as a Square **invoice** instead of a payment link:
  - Create a customer profile first if needed.
  - `CreateInvoice` with the order, `primary_recipient.customer_id`, `delivery_method: SHARE_MANUALLY`, `store_payment_method_enabled: true` and a due date of today.
  - `PublishInvoice`, then text the `public_url`.
- Invoice payment marks the order paid through the existing payment webhook. The builder confirms which events fire for invoice payments in sandbox and subscribes to any extra ones needed.
- The order record gains a `checkoutKind` field (`link`, `invoice` or `card_on_file`). Link-only fields become nullable. Expiry and replacement rules apply to invoices too: an unpaid invoice is cancelled the same way unpaid links are.
- Square's checkbox is the customer's consent to save the card. We don't store any card data, only Square's card id when needed.

### 5. Game timing

- **Data source: HockeyTech.** The SIJHL's own schedule page (sijhlhockey.com/stats/schedule) loads its data from HockeyTech's public JSON feed at `lscluster.hockeytech.com/feed/index.php`. I confirmed this in a browser on 2026-11-03. The calls it makes are:
  - `feed=modulekit&view=scorebar&numberofdaysahead=1&numberofdaysback=0&fmt=json&site_id=1&league_id=1`: today's games with live status, period and clock.
  - `feed=statviewfeed&view=schedule&season=45&team=-1&month=…`: the season schedule.
  - Both need the league's public `key` and `client_code`, which are embedded in the league site's page. They go in `.env` as `HOCKEYTECH_KEY` and `HOCKEYTECH_CLIENT_CODE`, and `HOCKEYTECH_TEAM` holds the Fort Frances Lakers team id or code.
  - JSONP callbacks are optional. Request plain JSON: drop `callback`, and strip a wrapping `( … )` if one is returned anyway.
- **Polling.** A game poller runs inside the app:
  - Once at startup and then hourly, fetch today's games and pick the Lakers **home** game, if there is one.
  - From 30 minutes before puck drop until the game is final, poll the scorebar every 30 seconds. The rest of the time, don't poll.
  - Use a polite `User-Agent`, back off on errors, and never poll more often than that.
- **Game state.** From each poll, keep: status (not started / in progress / intermission / final), current period, clock remaining, and the scheduled start.
- **Confirmed on 2026-11-03.** Settings: `HOCKEYTECH_KEY`, `HOCKEYTECH_CLIENT_CODE=sijhl` and `HOCKEYTECH_TEAM_ID=9` are in `.env`; the Lakers are code `FFL`, home venue Memorial Sports Centre. A sample response is saved at `tests/fixtures/hockeytech-scorebar-2026-11-03.json`. It returns `{"SiteKit":{"Scorebar":[…]}}` as plain JSON when `callback` is omitted. Fields used, all strings:
  - `ID`
  - `HomeID`, `VisitorID`
  - `GameDateISO8601`, e.g. `2026-11-08T15:15:00-05:00`
  - `GameStatus`: `1` scheduled, `4` final; in-progress values to be confirmed on the first live game
  - `GameStatusString`
  - `Intermission`: `0` or `1`
  - `Period`
  - `GameClock`: `MM:SS` remaining
  - Overtime and shootout values are still unseen. Treat anything unrecognized as "feed unsure", which turns game-timed pickups off.
  - Capture a live in-progress response on the next game (Nov 8, 3:15pm at home) and add it as a second fixture.
- **Timeline estimate.** Turn the game state into estimated intermission start times, using `.env` defaults:
  - `GAME_SECONDS_PER_CLOCK_MINUTE` (default 105): real seconds per minute of game clock, since stoppages make a 20-minute period last about 35 real minutes.
  - `GAME_INTERMISSION_MINUTES` (default 18).
  - Example: at 8:05 in the 2nd period with 6:00 left on the clock, the 2nd intermission starts at about 8:05 + 6 × 105 s ≈ 8:16.
  - Before puck drop, estimate from the scheduled start. Each new poll re-estimates.
- **Feed down.** If the feed fails or returns no Lakers game, game-timed pickups ("end of 2nd") are turned off. The bot says it can't see the game clock right now and offers ASAP or a clock time. The owner gets one alert per game night. Nothing is ever guessed silently.
- **Permission.** The key is public and the league's own site uses it from every visitor's browser. Using it from a server is still the league's data. The owner should ask the SIJHL (or HockeyTech) for permission before relying on it in production. *(Our call: build it, flag it.)*
- **Customer timing.** Customers say things like "end of 2nd", "next intermission", "after the game", "8:15" or "now". A new `set_pickup_time` tool takes a target (`asap`, `intermission:1|2`, `next_intermission`, `after_game`, or a clock time). Code turns it into a time from the game timeline; the AI never computes times itself.
- **Square order.** A pickup fulfillment with `schedule_type: SCHEDULED`, `pickup_at` set to the intermission start, and `prep_time_duration` set to `PREP_MINUTES` (default 8). The order then stays off the kitchen screen until pickup time minus prep. ASAP orders stay as they are today.
- **Estimate changes.** When a new estimate moves an intermission by 3 minutes or more, the app updates `pickup_at` on paid orders for that intermission that the kitchen hasn't started yet. The builder checks in sandbox which fulfillment states allow this.
  - The customer is texted only if their quoted ready time moves by **5 minutes or more**, and at most once per order. Example: "Heads up: the 2nd period is running long. Order #12 will be ready about 8:34."
  - If Square refuses an edit, the owner is alerted with the order number. The customer is told their order may be ready earlier than quoted. *(Our call.)*
- **Capacity.**
  - Each intermission takes at most `INTERMISSION_CAPACITY` orders (default 40). When it's full, the bot offers the next pickup slot. It never silently over-commits.
  - The existing `MAX_ACTIVE_ORDERS` limit applies only to ASAP and clock-time orders that are due now. Orders scheduled for a later intermission count toward that intermission's capacity, not toward the ASAP limit. *(Our call: otherwise 15 pre-orders would block the whole game.)*
- **No game tonight.** Game words ("end of 2nd") get "There's no Lakers home game today", and the order is treated as ASAP or a clock time.

### 6. Knowing when it's ready

- The "paid" text gains a position and time estimate, for example: "Paid! Order #12. You're 3rd for the 2nd intermission, ready about 8:28." For ASAP orders: "You're 3rd in line."
- The existing "ready" text is unchanged, and the chat-history note added in the last change stays.

### 7. Regular perks

- **"The usual" / "same as last time".** Paid orders store the cart they were built from (a new `cart` jsonb column). A `reorder_last` tool loads that cart into the current one. It is re-checked against the live menu and stock, so sold-out items are flagged, never silently dropped.
- **Loyalty.** If the Square seller has a loyalty program (`RetrieveLoyaltyProgram`):
  - Only customers who already have a Square Loyalty account earn points. The app never enrols anyone. *(Our call: enrolment needs consent and could become marketing.)*
  - Points are added when the order is picked up (Square fulfillment `COMPLETED`), so cancelled orders never earn. The program's own rules decide how many.
  - The greeting can mention a reward they can afford, for example: "You've got a free hot chocolate. Want it on this one?" Redeeming creates a loyalty reward on the order before payment, so Square applies the discount and the total still comes from Square.
  - No program means the feature quietly stays off.

## Owner commands (additions)

`STATUS` also shows the Lakers game (feed status, current period and clock, estimated intermissions) and the order count per intermission. `GAME` shows the same game details on their own. No manual period commands.

## Data changes

- **Conversation:** add `squareCustomerId`, `customerLookupAt`, `pendingOneTap` (cart hash plus the time it was offered), and `cardOfferMadeAt`.
- **Order:** add `checkoutKind`, `pickupAt`, `pickupSlot`, `invoiceId`, `squarePaymentId` and `cart`. The payment-link fields become nullable.
- **Settings:** store the latest game state from the feed as a JSON setting, so a restart mid-game recovers quickly.
- Schema changes are applied idempotently at startup, as today.

## Left to the builder

- Exact prompt wording, tool schemas and file layout.
- The order in which features are built (suggested: hours, customers, game timing, one-word pay, invoice card saving, perks).
- Which Square sandbox behaviours to confirm first: invoice payment events, editing scheduled orders, catalog availability periods.
- How to get `HOCKEYTECH_KEY` and `HOCKEYTECH_CLIENT_CODE`. They appear in the `lscluster.hockeytech.com` requests on sijhlhockey.com/stats/schedule, visible in a browser's network tab. Also the Lakers team id, which appears in the schedule feed.
- Test coverage, at the existing standard: scripted-model flow tests with the fake Square client.

## Decisions log

- **Owner:** Square business hours only; games don't open ordering. The game clock comes from the live feed, with no staff commands.
- **Ours, for the owner to check:**
  - Closed when no hours are set.
  - Square customer profile created after a customer's first paid order.
  - One-word pay capped at $60.
  - Customer texted about a ready-time change of 5 minutes or more, at most once per order.
  - The ASAP limit doesn't count orders scheduled for later intermissions.
  - Loyalty points only for existing members, added at pickup.
  - Build on the HockeyTech feed and ask the league for permission before production.
