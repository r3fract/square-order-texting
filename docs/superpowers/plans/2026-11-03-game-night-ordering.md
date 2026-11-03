# Game-Night Text Ordering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fans text an order from their seat. Square is the source of truth for hours, customers, saved cards and loyalty, and the Fort Frances Lakers live game clock times pickups to intermissions.

**Architecture:** This extends the existing Fastify + Postgres service. New Square REST calls go in `src/square/client.ts` behind the `SquareApi` interface; the test fake implements the same interface. Five new focused modules:
- `src/hours.ts`: Square business hours
- `src/customers.ts`: recognize customers, saved cards
- `src/game/*`: HockeyTech feed, timeline estimate, poller
- `src/pickup.ts`: pickup targets turned into times and slots
- `src/loyalty.ts`

`OrderService` gains two checkout paths: card on file, and an invoice with a "save card" checkbox. The agent gains tools, each guarded in code.

**Tech Stack:** TypeScript (ESM, Node 22), Fastify 5, pg, zod 4, vitest 5, Square REST (`SQUARE_API_VERSION=2026-09-16`), HockeyTech `lscluster` JSON feed.

**Spec:** [docs/superpowers/specs/2026-11-03-game-night-ordering-design.md](../specs/2026-11-03-game-night-ordering-design.md)

## Global Constraints

- **Prices** (totals, tax, discounts) come only from Square responses, never from the AI. The existing price guard in `runAgentTurn` stays.
- **Hours:** ordering is open only inside Square `business_hours`, or inside `ORDERING_HOURS` if that is set. If no hours are set anywhere, ordering is **closed**. Games never open ordering.
- **Card-on-file charges** need all of these:
  - the cart is unchanged since the offer
  - the offer was made at most **10 minutes** ago
  - the total is at most `ONE_TAP_MAX_CENTS` (default `6000`)
  - the idempotency key is `card:<orderRecordId>`
- **The AI never computes times.** Pickup times come from `resolvePickup`.
- **Game feed:** poll the scorebar every **30 s**, only from 30 min before puck drop until final. Refresh today's games **hourly**. Send a `User-Agent` of `text-to-order/1.0 (Fort Frances canteen ordering)`.
- **Feed unsure** (any failure, unknown `GameStatus`, period ≥ 4): game-timed pickups are off, and the owner gets at most one alert per game.
- **New `.env` settings:**
  - `GAME_SECONDS_PER_CLOCK_MINUTE=105`
  - `GAME_INTERMISSION_MINUTES=18`
  - `PREP_MINUTES=8`
  - `INTERMISSION_CAPACITY=40`
  - `ONE_TAP_MAX_CENTS=6000`
  - `HOCKEYTECH_KEY`, `HOCKEYTECH_CLIENT_CODE`, `HOCKEYTECH_TEAM_ID` (all optional; the game feature is off if any is missing)
- **Rescheduling:** update Square when an intermission moves **≥ 3 min**. Text the customer when their quoted time moves **≥ 5 min**, at most once per order.
- **Loyalty:** existing Square Loyalty members only, never enrol anyone. Points are added on fulfillment `COMPLETED`.
- **Texts:** no marketing texts. Every outbound text is about the customer's own order.
- **Git:** this folder is not under git yet. Run `git init` and make a first commit of the current tree before Task 1. Each task ends with a commit.

## Review Focus

1. **"Y" sent twice, or after editing the cart.** A double text must charge once. A "Y" after the cart changed or after 10 minutes must not charge, and must re-offer instead. Tests: Task 8.
2. **The phone matches several Square customer profiles.** Never pick one and charge its card. Treat the customer as recognized (greet with the most recently created profile's name) but turn off card features. Test: Task 4.
3. **The feed shows overtime, a shootout, an unknown status, or stops responding mid-game.** Game-timed pickups stop, existing scheduled orders keep their last pickup time, and the owner gets one alert. Tests: Tasks 5 and 7.
4. **The app restarts mid-game.** The game state is restored from settings, so "end of 2nd" keeps working without waiting for an hourly refresh. Test: Task 5.
5. **Payments that need the order rebuilt.** A loyalty reward or a re-quote can change the Square order total after the offer. Charge Square's current order total, and if it differs from the offered total, re-offer instead of charging. Test: Task 10.

---

### Task 1: Data model and storage

**Files:**
- Modify: `src/store/types.ts`, `src/store/memory.ts`, `src/store/postgres.ts`, `sql/schema.sql`
- Modify: `src/orders.ts` (record construction only), `tests/fakes.ts` if constructors break
- Test: `tests/store.test.ts` (new; runs against `MemoryStore`, and against `PostgresStore` when `TEST_DATABASE_URL` is set, following `tests/postgres.test.ts`)

**Interfaces (produces):**
```ts
export type PickupTarget =
  | { kind: "asap" }
  | { kind: "intermission"; n: 1 | 2 }
  | { kind: "next_intermission" }
  | { kind: "after_game" }
  | { kind: "clock"; hhmm: string };
export interface SavedCard { id: string; brand: string; last4: string }
export interface PendingOneTap { cartHash: string; totalCents: number; offeredAt: Date }

// Conversation gains:
squareCustomerId: string | null; customerAmbiguous: boolean; customerLookupAt: Date | null;
savedCard: SavedCard | null; pendingOneTap: PendingOneTap | null; cardOfferMadeAt: Date | null;
pickupTarget: PickupTarget | null; loyaltyAccountId: string | null;

// OrderRecord changes:
paymentLinkId: string | null; paymentLinkUrl: string | null;
checkoutKind: "link" | "invoice" | "card_on_file";
invoiceId: string | null; invoiceVersion: number | null; squarePaymentId: string | null;
customerId: string | null; cart: CartLine[];
pickupAt: Date | null; pickupSlot: string | null;   // slot key e.g. "game:4011:int2", "asap", "clock"
quotedReadyAt: Date | null; etaNotifiedAt: Date | null;

// Store gains:
countOrdersInSlot(slotKey: string): Promise<number>;           // status paid|awaiting_payment
listOrdersInSlotPrefix(prefix: string): Promise<OrderRecord[]>; // e.g. "game:4011:"
lastPaidOrderForPhone(phone: string): Promise<OrderRecord | null>; // status paid|ready|picked_up, newest
countActiveAsapOrders(now: Date): Promise<number>; // paid, and pickupAt null or <= now
```
`countActiveOrders` stays as it is (STATUS uses it).

- [ ] **Step 1:** Write `tests/store.test.ts`:
  - `"round-trips the new conversation and order fields"`: save a conversation with every new field set (dates as `Date`) and read it back with `toEqual`. Same for an order with `checkoutKind: "card_on_file"`, `paymentLinkId: null` and a two-line `cart`.
  - `"counts orders per slot and finds the last paid order"`: orders in `game:1:int2` with statuses paid, awaiting_payment and expired → `countOrdersInSlot` is `2`. `lastPaidOrderForPhone` returns the newest of two paid orders and ignores an expired one.
  - `"ASAP capacity ignores later intermission orders"`: a paid order with `pickupAt` = now + 60 min and one with `pickupAt` null → `countActiveAsapOrders(now)` is `1`.
- [ ] **Step 2:** Run `npx vitest run tests/store.test.ts`. Expected: FAIL (type or missing-method errors).
- [ ] **Step 3: Implement.**
  - `sql/schema.sql`: add idempotent `ALTER TABLE … ADD COLUMN IF NOT EXISTS` for each new field. Use `jsonb` for `saved_card`, `pending_one_tap`, `pickup_target` and `cart`, and `timestamptz` for the dates.
  - Drop `NOT NULL` from `payment_link_id` and `payment_link_url` with `ALTER COLUMN … DROP NOT NULL`.
  - Add the index `orders_slot ON orders (pickup_slot, status)`.
  - Update `toConversation` / `toOrder`, `newConversation` (all new fields null or false) and `MemoryStore`.
  - In `OrderService.checkout`, set `checkoutKind: "link"`, `cart: conv.cart`, `customerId: conv.squareCustomerId`, and null for the rest.
- [ ] **Step 4:** Run `npx vitest run`. Expected: all tests pass, including the existing 47.
- [ ] **Step 5:** Commit: `feat(store): fields for customers, saved cards, pickup slots`.

---

### Task 2: Square client additions

**Files:**
- Modify: `src/square/client.ts`, `tests/fakes.ts` (`FakeSquare`)
- Test: `tests/square-client.test.ts` (new; uses a fake `fetchImpl` that records method, path and JSON body and returns canned JSON)

**Interfaces (produces), added to `SquareApi`:**
```ts
retrieveLocation(): Promise<{ timezone?: string; business_hours?: { periods?: { day_of_week: string; start_local_time: string; end_local_time: string }[] } }>;
searchCustomersByPhone(phone: string): Promise<SquareCustomer[]>;   // POST /v2/customers/search, filter.phone_number.exact
createCustomer(a: { idempotencyKey: string; givenName: string; phone: string }): Promise<SquareCustomer>;
listCards(customerId: string): Promise<SquareCard[]>;                // GET /v2/cards?customer_id=…  (enabled only)
disableCard(cardId: string): Promise<void>;                          // POST /v2/cards/{id}/disable
createOrder(a: { idempotencyKey: string; order: SquareOrderInput }): Promise<SquareOrder>;
createPayment(a: { idempotencyKey: string; sourceId: string; customerId: string; orderId: string; amount: Money; locationId: string }): Promise<SquarePayment>;
createInvoice(a: { idempotencyKey: string; orderId: string; customerId: string; locationId: string; dueDate: string }): Promise<SquareInvoice>;
  // body: delivery_method SHARE_MANUALLY, store_payment_method_enabled true,
  // accepted_payment_methods { card: true, square_gift_card: false, bank_account: false, buy_now_pay_later: false, cash_app_pay: false },
  // payment_requests [{ request_type: "BALANCE", due_date }]
publishInvoice(id: string, version: number, idempotencyKey: string): Promise<SquareInvoice>;  // returns public_url
cancelInvoice(id: string, version: number): Promise<void>;           // 404/400-already-paid tolerated like deletePaymentLink 404
updatePickupAt(a: { orderId: string; version: number; fulfillmentUid: string; pickupAt: Date }): Promise<SquareOrder>;
retrieveLoyaltyProgram(): Promise<LoyaltyProgram | null>;            // GET /v2/loyalty/programs/main, 404 → null
searchLoyaltyAccount(customerId: string): Promise<LoyaltyAccount | null>;
accumulateLoyalty(a: { accountId: string; orderId: string; locationId: string; idempotencyKey: string }): Promise<void>;
createLoyaltyReward(a: { accountId: string; rewardTierId: string; orderId: string; idempotencyKey: string }): Promise<void>;

export interface SquareCustomer { id: string; given_name?: string; family_name?: string; phone_number?: string; created_at?: string }
export interface SquareCard { id: string; card_brand?: string; last_4?: string; enabled?: boolean }
export interface SquarePayment { id: string; status: string; order_id?: string; card_details?: { status?: string } }
export interface SquareInvoice { id: string; version: number; status?: string; public_url?: string; order_id?: string }
export interface LoyaltyProgram { id: string; reward_tiers: { id: string; name: string; points: number }[]; terminology?: { one?: string; other?: string } }
export interface LoyaltyAccount { id: string; balance: number }
```
- `SquareOrderInput` gains `customer_id?: string`.
- `SquareOrder` gains `version?: number` and `fulfillments[].pickup_details?.pickup_at`.
- The client gets the location id through a new `locationId` option on `createSquareClient`. Update `src/index.ts` and `scripts/*.ts`.

- [ ] **Step 1:** Write `tests/square-client.test.ts`, one `it` per method. Each asserts the HTTP method, path and the key body fields named above, and that the response is mapped into the return type. Required cases:
  - `searchCustomersByPhone("+18072768533")` sends `{ query: { filter: { phone_number: { exact: "+18072768533" } } } }`.
  - `createPayment` sends `source_id`, `customer_id`, `order_id`, `amount_money` and `location_id`, plus `autocomplete: true`.
  - `createInvoice` sends `store_payment_method_enabled: true` and `delivery_method: "SHARE_MANUALLY"`.
  - `retrieveLoyaltyProgram` returns `null` on a 404.
  - `cancelInvoice` doesn't throw on a 404.
- [ ] **Step 2:** Run `npx vitest run tests/square-client.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** each method with the existing `call<T>()` helper. `listCards` filters to `enabled !== false`.
- [ ] **Step 4: Extend `FakeSquare`** with in-memory `customers: SquareCustomer[]`, `cards: Map<customerId, SquareCard[]>`, `payments: SquarePayment[]`, `invoices: Map<string, SquareInvoice & { orderId; deleted? }>`, `orders: Map<string, SquareOrderInput & { version; pickupAt? }>`, `loyalty: { program: LoyaltyProgram | null; accounts: Map<customerId, LoyaltyAccount> }`, `businessHours` and `failNext: Partial<Record<keyof SquareApi, Error>>`.
  - `createPayment` honours idempotency: the same key returns the same payment.
  - A card with id `ccof:decline` returns `status: "FAILED"`.
- [ ] **Step 5:** Run `npx vitest run`. Expected: all tests pass.
- [ ] **Step 6:** Commit: `feat(square): customers, cards, payments, invoices, loyalty endpoints`.

---

### Task 3: Hours from Square

**Files:**
- Create: `src/hours.ts`
- Modify: `src/guards.ts` (`isOpen`, `nextOpeningText`, `describeHours`: `null` now means closed), `src/config.ts` (`hours` becomes the override only), `src/service.ts` (`orderingStatus`, agent `hoursText`), `src/index.ts` (startup warning), `tests/units.test.ts:46`
- Test: `tests/hours.test.ts`

**Interfaces (produces):**
```ts
export function hoursFromBusinessHours(periods: { day_of_week: string; start_local_time: string; end_local_time: string }[] | undefined): OrderingHours; // null when empty
export class HoursService {
  constructor(square: SquareApi, override: OrderingHours, ttlMs?: number /* default 15 min */);
  current(): Promise<OrderingHours>;   // override if set, else cached Square hours; on Square error keep last good value, null if none
}
```
- Multiple periods on the same day: if Square returns two periods for a day, keep the earliest open and latest close. *(Our call; record it in a code comment.)*
- `TextOrderService` constructs a `HoursService` and exposes `hours(): Promise<OrderingHours>`.
- Copy when no hours are set: `describeHours(null)` returns `"not set"`. `orderingStatus()` message when closed with no hours: `"Text ordering isn't open right now. Please order at the window."`

- [ ] **Step 1:** Write `tests/hours.test.ts`:
  - `"maps Square periods to ordering hours"`: `MON 09:00:00–17:00:00` → `{ mon: { open: 540, close: 1020 } }`.
  - `"no periods means closed"`: `isOpen(hoursFromBusinessHours([]), anyDate, tz) === false`.
  - `"override beats Square"`.
  - `"keeps last good hours when Square fails"`.
  - Service level: with `FakeSquare.businessHours` = Mon–Fri 9–5, `ORDERING_HOURS` empty, and the clock at Tue 23:42Z (6:42pm Toronto), a text gets a closed reply, and the scripted model is never called.
- [ ] **Step 2:** Update `tests/units.test.ts:46` to expect `isOpen(parseHours(""), …) === false`. Update `testConfig` and the flow tests that relied on "always open" to set `ORDERING_HOURS: "mon=00:00-23:59,…"` for all 7 days.
- [ ] **Step 3:** Run `npx vitest run`. Expected: the new tests FAIL.
- [ ] **Step 3b: Item hours check.** In sandbox, call `GET /v2/catalog/list?types=AVAILABILITY_PERIOD` and retrieve one item with `include_related_objects=true`. If items reference availability periods, add `availableNow(item, now, tz)` to `src/square/menu.ts`, treat out-of-window items as `[NOT AVAILABLE NOW]` in `menuForModel` and as a problem in `validateCart`, and add a test. If items don't reference them, write that down in a comment in `src/hours.ts` and skip.
- [ ] **Step 4: Implement.** At startup, `src/index.ts` calls `hours.current()`. If that's `null`, log it and send the owner, once: `"⚠️ Text ordering is closed: no business hours are set in Square. Set them in Square Dashboard → Locations."`
- [ ] **Step 5:** Run `npx vitest run`. Expected: all tests pass. Then run `npm run typecheck`. Expected: clean.
- [ ] **Step 6:** Commit: `feat(hours): ordering hours come from Square business hours`.

---

### Task 4: Recognize Square customers

**Files:**
- Create: `src/customers.ts`
- Modify: `src/service.ts` (look up the customer before the agent turn; create the profile in `onPaid`), `src/agent.ts` (prompt block), `src/orders.ts` (`buildSquareOrder` sets `customer_id`)
- Test: `tests/customers.test.ts`

**Interfaces:**
- Consumes: Task 2 `searchCustomersByPhone`, `createCustomer`, `listCards`, `searchLoyaltyAccount`; Task 1 fields.
- Produces:
```ts
export class CustomerService {
  constructor(square: SquareApi, now: () => Date);
  /** Refreshes conv.squareCustomerId / customerAmbiguous / customerName (if null) / savedCard / loyaltyAccountId when customerLookupAt is null or > 24h old. Never throws (logs and leaves fields). */
  refresh(conv: Conversation, opts?: { force?: boolean }): Promise<void>;
  /** After a first paid order: search again, else create with conv.customerName ?? "Text customer". Sets conv.squareCustomerId. */
  ensureProfile(conv: Conversation, idempotencyKey: string): Promise<string>;
}
```
- Several matching profiles: set `customerAmbiguous = true`, `savedCard = null` and `squareCustomerId = null`, and take the name from the most recently created profile.
- `savedCard` is the first enabled card from `listCards`, as `{ id, brand: card_brand, last4: last_4 }`.
- Prompt block, added under the "Customer:" line:
  `Square customer: yes (given name Riley) · saved card: VISA ••1111 · loyalty: 120 points` or `Square customer: no`.
  Instruction to add: "Greet known customers by first name once per chat."

- [ ] **Step 1:** Write `tests/customers.test.ts`:
  - `"greets a known customer by name and knows their card"`: `FakeSquare.customers` has Riley `+18075551234` with card `ccof:1` VISA 1111. One text → the system prompt contains `given name Riley` and `VISA ••1111`. The conversation's `customerName` is `"Riley"`.
  - `"looks up once a day, not every text"`: two texts → `searchCustomersByPhone` is called once.
  - `"two profiles with one phone: name yes, card no"` (Review Focus 2): the prompt has `saved card: none` and `customerAmbiguous` is true.
  - `"creates a profile after the first paid order"`: an unknown customer pays a link → `FakeSquare.customers` has one entry with `given_name` set to the name they gave, and the next Square order has `customer_id` set.
  - `"Square outage doesn't block ordering"`: `failNext.searchCustomersByPhone` → the text is still answered.
- [ ] **Step 2:** Run `npx vitest run tests/customers.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** `processInbound` calls `customers.refresh(conv)` before `runAgentTurn`. `onPaid` calls `ensureProfile` when `conv.squareCustomerId` is null and the customer isn't ambiguous, then sets `customerLookupAt = null` so the next text refreshes cards.
- [ ] **Step 4:** Run `npx vitest run`. Expected: all tests pass.
- [ ] **Step 5:** Commit: `feat(customers): recognize Square customers by phone`.

---

### Task 5: Lakers game feed and timeline

**Files:**
- Create: `src/game/hockeytech.ts`, `src/game/timeline.ts`, `src/game/service.ts`
- Modify: `src/config.ts` (new settings), `src/index.ts` (30 s interval calling `game.tick()`), `src/service.ts` (owns the `GameService`)
- Test: `tests/game.test.ts`, using `tests/fixtures/hockeytech-scorebar-2026-11-03.json` plus hand-made variants built in the test by cloning a fixture game and overriding fields

**Interfaces (produces):**
```ts
// hockeytech.ts
export type FeedStatus = "scheduled" | "in_progress" | "intermission" | "final" | "unknown";
export interface FeedGame { id: string; homeId: string; visitorId: string; startsAt: Date; status: FeedStatus; period: number; clockSeconds: number | null; venue: string }
export function parseScorebar(json: unknown): FeedGame[];
  // GameStatus "1"→scheduled, "4"→final; Intermission "1"→intermission;
  // otherwise "2"/"3" with Intermission "0"→in_progress (confirm on Nov 8); anything else→unknown
  // startsAt from GameDateISO8601; clockSeconds from GameClock "MM:SS"
export function fetchScorebar(o: { key: string; clientCode: string; fetchImpl?: typeof fetch }): Promise<FeedGame[]>;
  // GET https://lscluster.hockeytech.com/feed/index.php?feed=modulekit&view=scorebar&numberofdaysahead=1&numberofdaysback=0&limit=50&fmt=json&site_id=1&lang=en&league_id=1&key=…&client_code=…
  // strips a wrapping "( … )" before JSON.parse

// timeline.ts
export interface Timeline { gameId: string; intermissionStarts: { 1: Date | null; 2: Date | null }; gameEnd: Date | null; trustworthy: boolean }
export function estimateTimeline(g: FeedGame, now: Date, o: { secondsPerClockMinute: number; intermissionMinutes: number; intermissionStartedAt: Date | null }): Timeline;

// service.ts
export interface GameState { game: FeedGame | null; timeline: Timeline | null; feedOk: boolean; checkedAt: Date; intermissionStartedAt: Date | null; alertedGameId: string | null }
export class GameService {
  constructor(d: { fetchGames: () => Promise<FeedGame[]>; store: Store; teamId: string | null; now: () => Date; secondsPerClockMinute: number; intermissionMinutes: number; notifyOwner: (t: string) => Promise<void>; onTimelineChange: (prev: Timeline | null, next: Timeline) => Promise<void>; log: (m: string, e?: unknown) => void });
  load(): Promise<void>;          // restore GameState from setting "game_state"
  tick(): Promise<void>;          // decides whether to hit the network (hourly schedule, 30 s live window)
  state(): GameState | null;
  homeGameToday(): FeedGame | null; // only games where homeId === teamId
  usable(): boolean;              // feedOk && timeline?.trustworthy && game not final
  describe(tz: string): string;   // for STATUS / GAME, e.g. "Lakers vs DID 3:15pm · 2nd, 6:00 left · int2 ≈ 4:46pm"
}
```
**Timeline rule** (a period is 20 clock minutes, real length = clock minutes × `secondsPerClockMinute`):

```
P = 20 * spcm seconds; I = intermissionMinutes
scheduled:      e1 = start + P;          e2 = e1 + I + P;  end = e2 + I + P
in_progress p:  ep = now + clockSeconds/60 * spcm; then chain forward with I and P
intermission after p: nextStart = (intermissionStartedAt ?? now) + I; chain forward
past intermissions → null; period >= 4 or status unknown → trustworthy=false
```
`intermissionStartedAt` is set by `tick()` the first time it sees `intermission`, and cleared when play resumes.

- [ ] **Step 1:** Write `tests/game.test.ts`:
  - `"parses the saved scorebar"`: 17 games. Game `4011` has `homeId "9"`, `startsAt` = `2026-11-08T20:15:00.000Z`, `status "scheduled"`.
  - `"scheduled game: intermissions from puck drop"`: start 19:15 local with `spcm` 105 and `I` 18 → `int1` = start + 35 min, `int2` = start + 88 min, `end` = start + 141 min.
  - `"live game re-estimates from the clock"`: period 2, `clockSeconds` 360, now 20:05 local → `int2` ≈ 20:15:30.
  - `"overtime or unknown status is not trustworthy"` (Review Focus 3): period 4 → `trustworthy` false and `usable()` false.
  - `"feed failure turns game timing off and alerts once"`: `fetchGames` throws on two ticks inside the live window → `usable()` false, and `notifyOwner` is called once.
  - `"no Lakers home game today"`: the fixture on 2026-11-03 (an away game) → `homeGameToday()` is null.
  - `"polls only in the live window"`: with a fake clock, ticks at 13:00 and 13:00:30 make one call (the hourly refresh). Ticks at 14:50 and 14:50:30 (25 min before puck drop) make two calls.
  - `"restores state after restart"` (Review Focus 4): tick with a live game, then a fresh `GameService` on the same store → `load()` → `state().timeline` equals the earlier one.
- [ ] **Step 2:** Run `npx vitest run tests/game.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the three modules. `GameService` is constructed only when all three `HOCKEYTECH_*` settings are present; otherwise `TextOrderService.game` is `null`.
- [ ] **Step 4:** Run `npx vitest run`, then `npm run typecheck`. Expected: all tests pass, typecheck clean.
- [ ] **Step 5:** Commit: `feat(game): HockeyTech feed, intermission timeline, poller`.

---

### Task 6: Pickup timed to intermissions

**Files:**
- Create: `src/pickup.ts`
- Modify: `src/agent.ts` (`set_pickup_time` tool and prompt lines), `src/orders.ts` (`buildSquareOrder` scheduled pickup, capacity in `checkout`), `src/service.ts` (paid text)
- Test: `tests/pickup.test.ts`, plus a flow test in `tests/flow.test.ts`

**Interfaces:**
- Consumes: Task 5 `GameService.state()`, `usable()`, `Timeline`; Task 1 `countOrdersInSlot`, `countActiveAsapOrders`.
- Produces:
```ts
export type ResolvedPickup = { ok: true; pickupAt: Date | null; slotKey: string; label: string } | { ok: false; reason: string };
export function resolvePickup(t: PickupTarget, game: GameState | null, gameUsable: boolean, now: Date, tz: string): ResolvedPickup;
  // asap → { pickupAt: null, slotKey: "asap", label: "right away" }
  // intermission n → slotKey `game:${id}:int${n}`, label "the 1st intermission" / "the 2nd intermission"
  // next_intermission → the first future intermission; after_game → slotKey `game:${id}:end`, label "after the game"
  // clock "HH:MM" → today in tz, must be in the future; slotKey "clock", label "about 8:15pm"
  // game target with no home game today → reason "There's no Lakers home game today."
  // game target with !gameUsable → reason "I can't see the game clock right now, so I can do right away or a time like 8:15."
  // intermission already past → reason "The 2nd intermission has already started. Want it right away instead?"
```
- **`set_pickup_time` tool:** input `{ target: "asap" | "intermission_1" | "intermission_2" | "next_intermission" | "after_game" | "clock", clock?: string }`. It stores `conv.pickupTarget` and returns `"Pickup set for {label}, ready about {h:mm}."`, or the `reason`.
- **Checkout:**
  - `checkout` re-resolves the pickup target with the current game state.
  - Slots starting `game:` are refused when `countOrdersInSlot(slotKey) >= INTERMISSION_CAPACITY`, with: `"The {label} is full. Want the next one, or right away?"`.
  - ASAP and clock orders use `countActiveAsapOrders(now) >= MAX_ACTIVE_ORDERS` in place of `countActiveOrders`.
- **`buildSquareOrder`:** gains `pickupAt?: Date` and `prepMinutes: number`. When `pickupAt` is set, the order uses `schedule_type: "SCHEDULED"`, `pickup_at: pickupAt.toISOString()` and `prep_time_duration: "PT{prep}M"`, and the note becomes `Text order #N · {label}`. ASAP stays as it is today.
- **Record:** `pickupAt`, `pickupSlot` and `quotedReadyAt` (= `pickupAt` ?? null).
- **Paid text** (exact copy):
  - game slot: `Paid, thanks! Order #{n}. You're {ordinal} for {label}, ready about {h:mm}. We'll text you when it's ready.`
  - ASAP: `Paid, thanks! Order #{n}. You're {ordinal} in line. We'll text you when it's ready.`
  - `ordinal` is 1 + the count of orders in the same slot with an earlier `paidAt`, written `1st` / `2nd` / `3rd` / `4th` …
- **Prompt lines:** the game summary (`game.describe(tz)`, or `No Lakers home game today.`). Plus: "When they say end of a period, intermission, after the game or a time, call set_pickup_time. Never work out times yourself."

- [ ] **Step 1:** Write `tests/pickup.test.ts` with the `resolvePickup` cases listed above: asap, int2, next_intermission, after_game, clock in the past (refused), no home game, unusable feed, intermission already past.
- [ ] **Step 2:** Add flow test `"orders for the 2nd intermission land on the kitchen screen at the right time"`:
  - Game 4011 is live, so `int2` = T.
  - Script `set_cart`, `set_pickup_time {target:"intermission_2"}`, `send_checkout_link`.
  - The Square link order has `pickup_details.schedule_type: "SCHEDULED"`, `pickup_at` = T, and `prep_time_duration: "PT8M"`.
  - After payment the text matches `/You're 1st for the 2nd intermission, ready about/`.
- [ ] **Step 3:** Add flow test `"a full intermission offers the next slot"`: `INTERMISSION_CAPACITY: "1"`, one paid int2 order → the second checkout's tool result contains `is full`.
- [ ] **Step 4:** Add flow test `"pre-orders don't block ASAP orders"`: `MAX_ACTIVE_ORDERS: "1"`, one paid int2 order an hour away → an ASAP checkout succeeds.
- [ ] **Step 5:** Run `npx vitest run`. Expected: the new tests FAIL.
- [ ] **Step 6:** Implement.
- [ ] **Step 7:** Run `npx vitest run`. Expected: all tests pass.
- [ ] **Step 8:** Commit: `feat(pickup): time orders to Lakers intermissions`.

---

### Task 7: Keep scheduled orders in sync with the game

**Files:**
- Create: `src/schedule.ts`
- Modify: `src/service.ts` (wire `onTimelineChange`)
- Test: `tests/schedule.test.ts`

**Interfaces:**
- Consumes: Task 2 `updatePickupAt`, `retrieveOrder`; Task 1 `listOrdersInSlotPrefix`; Task 5 `Timeline`.
- Produces:
```ts
export async function reconcileSchedule(d: { square: SquareApi; store: Store; now: () => Date; tz: string; sendCustomer: (phone: string, t: string) => Promise<boolean>; notifyOwner: (t: string) => Promise<void> }, prev: Timeline | null, next: Timeline): Promise<void>;
```
- For each order in `game:{id}:int{n}` or `game:{id}:end` with status `paid`:
  - **Moved ≥ 3 min** (`|newStart − order.pickupAt| ≥ 3 min`): call `retrieveOrder` for the version and fulfillment uid, then `updatePickupAt`, and save the new `pickupAt`.
  - **Quoted time moved ≥ 5 min** (`|newStart − quotedReadyAt| ≥ 5 min`) and `etaNotifiedAt` null: text `Heads up: the {period word} period is running {long|short}. Order #{n} will be ready about {h:mm}.` ("long" when later, "short" when earlier). Set `etaNotifiedAt` and `quotedReadyAt`.
  - **Square refuses** (any `SquareError`): owner gets `⚠️ Couldn't move order #{n} to {h:mm} in Square. It may be ready early.` and the customer gets, once, `Heads up: order #{n} may be ready a little before {old h:mm}.`
- When the next timeline isn't trustworthy, do nothing: orders keep their last time (Review Focus 3).

- [ ] **Step 1:** Write `tests/schedule.test.ts`:
  - `"a 2-minute shift changes nothing"`.
  - `"a 4-minute shift moves Square but doesn't text"`.
  - `"a 6-minute shift texts the customer once"`: two successive 6-minute shifts → one text.
  - `"Square refusing an edit alerts the owner"`.
  - `"untrustworthy timeline leaves orders alone"`.
- [ ] **Step 2:** Run `npx vitest run tests/schedule.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. Wire it as `GameService.onTimelineChange`.
- [ ] **Step 4:** Run `npx vitest run`. Expected: all tests pass.
- [ ] **Step 5:** Commit: `feat(schedule): follow the game clock for scheduled pickups`.

---

### Task 8: One-word pay with a saved card

**Files:**
- Modify: `src/orders.ts` (`offerOneTap`, `payWithSavedCard`), `src/agent.ts` (tools, `set_cart` result, prompt lines), `src/service.ts` (`forgetCard` helper)
- Test: `tests/onetap.test.ts`

**Interfaces:**
- Consumes: Task 2 `createOrder`, `createPayment`, `disableCard`; Task 4 `conv.savedCard`; Task 6 pickup resolution in checkout.
- Produces:
```ts
export function cartHash(cart: CartLine[]): string; // stable sha256 of sorted JSON
// OrderService:
oneTapEligible(conv: Conversation, totalCents: number): boolean; // savedCard && squareCustomerId && !customerAmbiguous && totalCents <= ONE_TAP_MAX_CENTS
payWithSavedCard(conv: Conversation): Promise<CheckoutResult | { ok: false; reason: string; fallbackToLink: true }>;
```
- **`set_cart` result:** after a successful quote, if `oneTapEligible`, the code sets `conv.pendingOneTap = { cartHash, totalCents, offeredAt: now }` and adds to the tool result: `Offer one-word pay: end your read-back with "Pay with {BRAND} ••{last4}? Reply Y." Don't send a link unless they ask.`
- **`pay_with_saved_card` tool:** calls `payWithSavedCard`. It refuses with a reason, and never charges, if any of these hold:
  - no `pendingOneTap`, or the hash differs from the current cart's
  - the offer is older than 10 min
  - the quoted total differs from Square's current order total
  - the cart fails validation, or ordering is closed, or there's no capacity (the same gates as `checkout`)
- **Steps:**
  - Create the record id.
  - `createOrder` (idempotency `order:<recordId>`) with `customer_id`.
  - Re-check `order.total_money.amount === pendingOneTap.totalCents`; if not, set a new pending offer and return a refusal containing the new total.
  - `createPayment` (idempotency `card:<recordId>`, amount = Square's order total).
  - On `COMPLETED`: save the record (`checkoutKind: "card_on_file"`, `squarePaymentId`) and run the existing `onPaid` flow through `TextOrderService.markPaid(squareOrderId)`. Make `onPaid` public as `markPaid`; it already ignores duplicates.
  - Clear `pendingOneTap`.
- **Duplicate "Y":** a second "Y" finds `pendingOneTap` null and is refused with `"That order is already paid."` (Review Focus 1). `withLock` already serialises the two texts.
- **Declined:** return `fallbackToLink: true`. The tool then calls `checkout(conv)` and the reply starts with `That card didn't go through, so here's a secure link instead.`
- **`forget_saved_card` tool:** `disableCard(conv.savedCard.id)`, then `conv.savedCard = null`. Result: `"Card removed. You'll get a payment link from now on."`
- **Prompt line:** "If you offered one-word pay and they reply Y / yes / yep, call pay_with_saved_card. Anything else about the order means re-read and re-offer."

- [ ] **Step 1:** Write `tests/onetap.test.ts`:
  - `"Y pays with the saved card, no link"`: a known customer with `ccof:1`. Script `set_cart` → `say(read-back)`, then on "Y" `pay_with_saved_card` → `say("Done!")`. Assert: `FakeSquare.payments` has 1 with `source_id ccof:1` and amount = Square total; no payment link was created; the customer got the paid text with an order number.
  - `"double Y charges once"` (Review Focus 1): send "Y" twice → 1 payment; the second tool result contains `already paid`.
  - `"Y after changing the cart doesn't charge"`: after the offer, the test changes `conv.cart` directly (simulating an edit that skipped `set_cart`), then sends "Y" → the tool is refused and there are 0 payments.
  - `"Y after 10 minutes doesn't charge"`: advance the clock 11 min → refused, 0 payments.
  - `"over the cap gets a link"`: `ONE_TAP_MAX_CENTS: "500"` → the `set_cart` result has no one-word-pay offer.
  - `"declined card falls back to a link"`: card `ccof:decline` → reply contains `didn't go through` and a `square.link` URL.
  - `"forget my card"`: `disableCard` called; `savedCard` null.
- [ ] **Step 2:** Run `npx vitest run tests/onetap.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npx vitest run`. Expected: all tests pass.
- [ ] **Step 5:** Commit: `feat(pay): one-word pay with a Square card on file`.

---

### Task 9: Save-a-card checkout through a Square invoice

**Files:**
- Modify: `src/orders.ts` (`checkoutWithInvoice`, `retire` by kind), `src/agent.ts` (`send_card_save_page` tool, offer rule), `src/service.ts` (webhook types), `src/app.ts` only if a new event needs routing
- Test: `tests/invoice.test.ts`

**Interfaces:**
- Consumes: Task 2 invoice methods and `createOrder`; Task 4 `ensureProfile`; Task 6 pickup resolution and capacity.
- Produces:
  - `OrderService.checkoutWithInvoice(conv: Conversation): Promise<CheckoutResult>`.
  - `OrderService.retire(order, status)` now branches on `checkoutKind`:
    - `link`: `deletePaymentLink`
    - `invoice`: `cancelInvoice(invoiceId, invoiceVersion)`
    - `card_on_file`: no Square call
- **Flow:**
  - Same gates as `checkout`.
  - `ensureProfile`, then `createOrder` with `customer_id`.
  - `createInvoice` with `dueDate` = today in TZ as `YYYY-MM-DD`, then `publishInvoice`.
  - Record: `checkoutKind: "invoice"`, `paymentLinkUrl: invoice.public_url`, `invoiceId`, `invoiceVersion`.
  - The reply appends the summary and `Pay here, and tick "Save my card on file" for one-word ordering next time:\n{public_url}`.
- **When to offer** (code sets a tool-result hint): when sending a checkout and `conv.savedCard` is null, `!customerAmbiguous` and `cardOfferMadeAt` is null, the `set_cart` result adds `Once, offer: "Want one-word ordering next time? I can send a Square page where you tick 'save my card'." If yes, call send_card_save_page instead of send_checkout_link.` Then set `cardOfferMadeAt`.
- **Payment events:** invoice payments arrive as `payment.created` / `payment.updated` with the order's `order_id`, so the existing handler marks them paid.
  - Also handle `invoice.payment_made` (`data.object.invoice.order_id`) the same way. Add that event to the Square subscription in the README.
  - After paid: `conv.customerLookupAt = null`, so the saved card is picked up on the next text.
- **Check in sandbox before writing the test:** create and publish one invoice with the real sandbox token, pay it with test card 4111 1111 1111 1111 with the box ticked, and confirm (a) which webhook events arrive and (b) `listCards` shows the card afterwards. Record the result in a comment at the top of `tests/invoice.test.ts`.

- [ ] **Step 1:** Run the sandbox check above (it needs the running app and ngrok; see README). Note the events.
- [ ] **Step 2:** Write `tests/invoice.test.ts`:
  - `"offers the save-card page once"`: the first order's `set_cart` result contains `save my card`; the second chat's doesn't.
  - `"save-card checkout sends a Square invoice page"`: `FakeSquare.invoices` has 1 with `store_payment_method_enabled` and the customer id; the reply contains its `public_url`.
  - `"paying the invoice marks the order paid and refreshes the card"`: a `payment.updated` COMPLETED event for the invoice's order → status `paid`; the next text calls `listCards`.
  - `"unpaid invoices expire like links"`: advance past `CART_EXPIRY_MINUTES` → `cancelInvoice` called; status `expired`.
- [ ] **Step 3:** Run `npx vitest run tests/invoice.test.ts`. Expected: FAIL.
- [ ] **Step 4:** Implement.
- [ ] **Step 5:** Run `npx vitest run`. Expected: all tests pass.
- [ ] **Step 6:** Commit: `feat(pay): save a card through Square's invoice page`.

---

### Task 10: "The usual" and loyalty

**Files:**
- Create: `src/loyalty.ts`
- Modify: `src/agent.ts` (`reorder_last` and `redeem_reward` tools, prompt), `src/orders.ts` (reward applied before card or invoice payment), `src/service.ts` (accumulate on picked up)
- Test: `tests/perks.test.ts`

**Interfaces:**
- Consumes: Task 1 `lastPaidOrderForPhone`; Task 2 loyalty methods; Task 8 and Task 9 order creation.
- Produces:
```ts
export class LoyaltyService {
  constructor(square: SquareApi, locationId: string);
  program(): Promise<LoyaltyProgram | null>;                  // cached 1h
  affordableTier(balance: number): Promise<{ id: string; name: string; points: number } | null>;
  accumulate(order: OrderRecord, accountId: string): Promise<void>; // idempotency `loyalty:<order.id>`, errors logged not thrown
}
```
- **`reorder_last` tool:** loads `lastPaidOrderForPhone(conv.phone).cart` into `conv.cart`, then returns the same result as `set_cart` (quote, problems, one-tap offer). Sold-out lines appear as problems; they're never dropped silently. No previous order → `"No earlier order found."`
- **`redeem_reward` tool:** `{ tier_id }`. Allowed only when `affordableTier` returns that tier and the checkout will be card-on-file or invoice. Store `conv.pendingRewardTierId` (add this field to Conversation in this task). `payWithSavedCard` and `checkoutWithInvoice` then call `createLoyaltyReward` after `createOrder` and re-read the order total, following the re-offer rule from Task 8 (Review Focus 5). With a payment link: `"Rewards work with a saved card or the save-card page."`
- **Accumulate:** `onPickedUp` (fulfillment `COMPLETED`) calls `loyalty.accumulate` when the conversation has `loyaltyAccountId`. Never enrol anyone.
- **Prompt:** "Loyalty: {balance} points; can redeem: {tier name}" when a tier is affordable, plus "Mention an available reward once per chat."

- [ ] **Step 1:** Write `tests/perks.test.ts`:
  - `"the usual reorders the last paid cart"`: after a paid order, a new chat calls `reorder_last` → `conv.cart` equals the old cart and the tool result contains the Square total.
  - `"the usual flags sold-out items"`: set `V_POUTINE` stock to 0 → the tool result contains `sold out`.
  - `"points are added at pickup, not payment"`: a member pays → no `accumulateLoyalty`; fulfillment `COMPLETED` → 1 call with idempotency `loyalty:<id>`.
  - `"non-members are never enrolled"`: no loyalty account calls beyond search.
  - `"a reward that changes the total re-offers instead of charging"` (Review Focus 5): the fake applies a $4 discount on `createLoyaltyReward` → the first "Y" is refused with the new total and 0 payments; a second "Y" pays the new total.
- [ ] **Step 2:** Run `npx vitest run tests/perks.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npx vitest run`. Expected: all tests pass.
- [ ] **Step 5:** Commit: `feat(perks): the usual and Square Loyalty`.

---

### Task 11: Owner view, docs and a live check

**Files:**
- Modify: `src/service.ts` (`STATUS` and new `GAME` owner command), `README.md`, `.env.example`, `docker-compose.yml` (none expected)
- Test: `tests/flow.test.ts` (owner commands)

**What changes:**
- `STATUS` appends `game.describe(tz)` (or `Game feed: off` / `No Lakers home game today`) and one line per game slot: `int1: 12 orders · int2: 3 · after: 0`.
- `GAME` replies with `game.describe(tz)` alone.
- README:
  - new "Game night" section: the feed, the settings, and asking the SIJHL for permission
  - "One-word pay" section
  - "Hours come from Square" note
  - Square webhook events gain `invoice.payment_made`
- `.env.example`: all new settings with the defaults from Global Constraints.

- [ ] **Step 1:** Write flow test `"STATUS shows the game and slot counts"`: a live fixture game and 2 int2 orders → the owner reply matches `/2nd/` and `/int2: 2/`.
- [ ] **Step 2:** Run `npx vitest run`. Expected: the new test FAILS.
- [ ] **Step 3:** Implement. Update the docs.
- [ ] **Step 4:** Run `npx vitest run` and `npm run typecheck`. Expected: all tests pass, typecheck clean.
- [ ] **Step 5:** Rebuild and run the stack: `docker compose up -d --build`. Then `docker compose logs app --tail 20`. Expected: `Loaded N menu items` and no errors.
- [ ] **Step 6: Live check in sandbox:**
  - `scripts/chat.ts` order with "Y" pay after saving a card through the invoice page (Task 9 check).
  - `GAME` from `OWNER_PHONE` shows the next Lakers home game.
  - With Square hours Mon–Fri 9–5, a text at 6pm gets the closed reply.
- [ ] **Step 7: On Sun 2026-11-08 during the 3:15pm home game:** save one live scorebar response to `tests/fixtures/hockeytech-scorebar-live.json`. Confirm the in-progress `GameStatus` values, and adjust `parseScorebar` with a test if they differ from `"2"`/`"3"`.
- [ ] **Step 8:** Commit: `docs: game night, one-word pay, Square hours; owner GAME command`.
