# Text-to-Order

Customers text a regular phone number in plain language ("2 poutines, a large fries and a dirty dr pepper w coconut, pickup after 2nd period"). Claude builds the order against your **live Square catalog and stock**. Square prices it, and the customer gets a Square checkout link (Apple Pay, Google Pay or card). Once they pay, the order shows up in Square POS / KDS as a pickup order. When staff mark it ready in Square, the customer gets a text.

```
Customer SMS ─► Twilio ─► this service (Claude + tools) ─► Square Catalog / Inventory / Orders / Checkout
       ▲                                                         │
       └──────────── reply + pay link ◄──── webhooks (paid, ready) ┘
```

## What it guarantees

- **Prices come from Square, never the AI.** The summary and total in the payment text are built in code from Square's `CalculateOrder` / payment-link order. The AI only picks catalog ids.
- **No overselling.** The cart is checked against sold-out flags and inventory when it's built, and again (with a fresh catalog) right before the link is made.
- **Kitchen only sees paid orders.** Square creates the order with the payment link; it appears in POS once paid.
- **Edits can't be paid at the old price.** Every new link deletes the previous unpaid one. Unpaid links expire after `CART_EXPIRY_MINUTES`.
- **No card numbers by text.** Anything that looks like a card number is removed before it reaches the AI, the logs or the database.
- **The AI can't quote its own math.** Any dollar amount in a reply that didn't come from the menu or Square is caught, and the reply is swapped for Square's summary.
- **No paying twice.** If an old link gets paid, the newer one is cancelled and the customer is told which order went through.
- **Links don't outlive ordering.** `PAUSE`, closing time and `STOP` cancel every unpaid link.
- **Webhooks are verified, de-duplicated and retry-safe** (Twilio signature, Square HMAC). A failed text never undoes a payment, and if processing an event crashes, Square's retry runs it again.

## Owner controls (text these from `OWNER_PHONE` to your Twilio number)

| Text | Does |
|---|---|
| `PAUSE` / `RESUME` | Turn text ordering off/on (e.g. during a rush) |
| `STATUS` | Open/closed, paid orders waiting, recent orders |
| `TO 1234 your message` | Reply to the customer whose number ends in 1234 (bot goes quiet for 2h) |
| `BOT 1234` | Give that customer back to the bot |

Customers can text `HUMAN` (or the AI hands off on complaints, refunds, allergy questions). Their messages are forwarded to you until you hand back. `STOP` / `START` are honoured (Twilio also handles these itself).

Anything else you text from your own phone is treated like a customer order, which is handy for testing.

## Setup

### 1. Square
1. Go to developer.squareup.com and create an application.
2. Copy the **Sandbox** access token and a sandbox **Location ID** into `.env` (`SQUARE_ENV=sandbox`).
3. Add catalog items in the sandbox Square Dashboard, with modifier lists for things like soda base and flavour shots. Mark required choices as required (min 1). Run `npm run menu` to see the menu exactly as the AI will.
4. Under **Webhooks**, add a subscription to `https://YOUR_DOMAIN/webhooks/square` with the events `payment.created`, `payment.updated` and `order.fulfillment.updated`. Copy the **signature key** to `SQUARE_WEBHOOK_SIGNATURE_KEY`.
5. Production: swap in the production token, location and webhook signature key, and set `SQUARE_ENV=production`. Apple Pay only works in production; the sandbox only takes test cards.

### 2. Twilio
1. Buy a local Canadian number with SMS.
2. Complete A2P 10DLC registration (Brand + Campaign, use case "Customer care / Account notifications", 2-way ordering). Numbers bought after March 26, 2025 need it even for Canada-only texting. Approval usually takes days.
3. Under the number's **Messaging → A message comes in**, set the webhook to `https://YOUR_DOMAIN/webhooks/twilio/sms` (HTTP POST).
4. Put the SID, auth token and number in `.env`.

Note: a customer texting just the single word **CANCEL** is treated by carriers and Twilio as an opt-out. The AI tells people to say "cancel my order" instead, but it's worth knowing.

### 3. Claude
Create an API key at console.anthropic.com → `ANTHROPIC_API_KEY`. The default model is `claude-sonnet-5-5`.

### 4. Try it in your terminal first (no Twilio needed)
```bash
npm install
cp .env.example .env   # fill in Square sandbox + Anthropic key; leave DATABASE_URL empty
npm run chat
```
Text like a customer. A real sandbox payment link is created. Type `/paid` to simulate payment and `/ready` to simulate the kitchen marking it ready.

### 5. Deploy on your VPS
```bash
cp .env.example .env    # fill everything in, set a long random ADMIN_TOKEN and POSTGRES_PASSWORD
docker compose up -d --build
docker compose logs -f app
```
Put HTTPS in front of port 3000. With Caddy:
```
order.yourdomain.ca {
  reverse_proxy 127.0.0.1:3000
}
```
`PUBLIC_BASE_URL` must be exactly that https address, or signature checks will fail.

### Admin API
`Authorization: Bearer $ADMIN_TOKEN`
- `GET /admin/status`, `GET /admin/orders`, `GET /admin/conversations` (includes transcripts)
- `POST /admin/pause`, `POST /admin/resume`, `POST /admin/refresh-menu`

## Settings worth knowing
| Setting | Default | What it does |
|---|---|---|
| `ORDERING_HOURS` | always open | e.g. `fri=17:00-23:00,sat=11:00-01:00` (windows past midnight work) |
| `MAX_ACTIVE_ORDERS` | 15 | Paid-but-not-ready text orders before new ones are turned away |
| `CART_EXPIRY_MINUTES` | 20 | Unpaid links are deleted after this |
| `ALLOW_TIPPING` | false | Square's checkout suggests a tip by default; off keeps the total matching the text |
| `PICKUP_INSTRUCTIONS` | | Included in the "ready" text |

## Before go-live checklist
- [ ] In sandbox, check that a paid test order appears in Square **Orders** (and on your KDS/printer) as a pickup order with the customer's name and the "Text order #N · pickup note".
- [ ] Mark it **Ready** in Square and confirm the ready text arrives.
- [ ] Do one real small Apple Pay purchase in production from an iPhone (Safari opens the link), then refund it.
- [ ] Text `PAUSE`, try ordering, text `RESUME`.
- [ ] Text `HUMAN`, reply with `TO 1234 …`, then `BOT 1234`.

## Development
```bash
npm test                    # 46 tests: guards, cart rules, pricing, full order flows, webhook retries, races, AI price guard
TEST_DATABASE_URL=postgres://... npm test   # also tests the Postgres store
npm run typecheck
```

Code map: `src/agent.ts` (prompt + tools), `src/orders.ts` (cart rules, Square order, payment links), `src/service.ts` (SMS handling, owner commands, webhooks, expiry), `src/square/*` (Square API, menu), `src/store/*` (Postgres / memory), `src/app.ts` (HTTP routes).

## Later
- **Run one app instance.** Per-customer locking is in memory; scaling to several instances needs a Postgres advisory lock.
- **Multi-tenant**: one Twilio number per location → per-location config, to fold into the Square platform.
- **Platform fee**: adding `app_fee_money` to payment links hides Apple Pay on Square's hosted page, so charge clients a subscription instead, or move to your own checkout page with the Web Payments SDK.
- **Scheduled pickup times**: currently ASAP with a free-text pickup note ("after 2nd period").
