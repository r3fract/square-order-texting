import { describe, expect, it } from "vitest";
import { parseHours } from "../src/config.js";
import { describeHours, isOpen, keyword, nextOpeningText, redactCardNumbers } from "../src/guards.js";
import { buildSquareOrder, quoteFromOrder, validateCart } from "../src/orders.js";
import { buildMenu, formatMoney, menuForModel } from "../src/square/menu.js";
import { signSquareBody, verifySquareSignature } from "../src/square/webhook.js";
import { newConversation } from "../src/store/types.js";
import { canteenCatalog, FakeSquare, LOC } from "./fakes.js";

describe("card number redaction", () => {
  it("removes real-looking card numbers in any spacing", () => {
    for (const s of ["4111111111111111", "4111 1111 1111 1111", "4111-1111-1111-1111", "my card is 5555555555554444 exp 12/28"]) {
      const r = redactCardNumbers(s);
      expect(r.found).toBe(true);
      expect(r.text).not.toMatch(/\d{4}[ -]?\d{4}[ -]?\d{4}/);
    }
  });
  it("leaves phone numbers, prices and order numbers alone", () => {
    for (const s of ["call 807-555-0147", "+18075550147", "2 poutines for $18.00", "order #47", "1234567890123"]) {
      expect(redactCardNumbers(s)).toEqual({ text: s, found: false });
    }
  });
});

describe("ordering hours", () => {
  const tz = "America/Toronto";
  const hours = parseHours("tue=17:00-22:30,sat=18:00-01:00");
  // 2026-11-03 is a Tuesday. Toronto is UTC-5 in November.
  const at = (iso: string) => new Date(iso);

  it("is open inside a window and closed outside", () => {
    expect(isOpen(hours, at("2026-11-03T23:00:00Z"), tz)).toBe(true); // 6pm Tue
    expect(isOpen(hours, at("2026-11-03T20:00:00Z"), tz)).toBe(false); // 3pm Tue
    expect(isOpen(hours, at("2026-11-04T04:00:00Z"), tz)).toBe(false); // 11pm Tue
  });
  it("handles a window that runs past midnight", () => {
    expect(isOpen(hours, at("2026-11-08T05:30:00Z"), tz)).toBe(true); // 12:30am Sun, from Sat window
    expect(isOpen(hours, at("2026-11-08T06:30:00Z"), tz)).toBe(false); // 1:30am Sun
  });
  it("says when ordering opens next", () => {
    expect(nextOpeningText(hours, at("2026-11-03T20:00:00Z"), tz)).toBe("Text ordering opens today at 5pm.");
    expect(nextOpeningText(hours, at("2026-11-04T04:00:00Z"), tz)).toBe("Text ordering opens Saturday at 6pm.");
    expect(describeHours(hours)).toBe("Tuesday 5pm-10:30pm, Saturday 6pm-1am");
  });
  it("empty hours means closed", () => {
    expect(isOpen(parseHours(""), new Date(), tz)).toBe(false);
  });
  it("rejects badly written hours", () => {
    expect(() => parseHours("tuesday 5-10")).toThrow(/ORDERING_HOURS/);
  });
});

describe("keywords", () => {
  it("recognizes opt-out and person requests only as whole messages", () => {
    expect(keyword("STOP")).toBe("stop");
    expect(keyword(" stop. ")).toBe("stop");
    expect(keyword("human")).toBe("human");
    expect(keyword("stop the gravy on one")).toBe(null);
  });
});

describe("menu", () => {
  const menu = buildMenu(canteenCatalog(), LOC);

  it("skips archived items and reads modifier rules", () => {
    expect(menu.items.map((i) => i.name)).toEqual(["Fries", "Mozza Sticks", "Poutine", "Dirty Soda"]);
    const soda = menu.items.find((i) => i.name === "Dirty Soda")!;
    expect(soda.modifierLists.map((m) => [m.name, m.min, m.max])).toEqual([
      ["Soda base", 1, 1],
      ["Flavour shots", 0, 2],
    ]);
  });

  it("marks sold-out items and options in the text the AI sees", () => {
    const text = menuForModel(menu, new Map([["V_MOZZA", 0]]));
    expect(text).toMatch(/Mozza Sticks[\s\S]*id=V_MOZZA \$8\.00 \[SOLD OUT\]/);
    expect(text).toMatch(/"Vanilla" id=MOD_VAN \+\$0\.50 \[SOLD OUT\]/);
    expect(text).toMatch(/"Soda base" \(required, pick 1\)/);
  });

  it("formats money", () => {
    expect(formatMoney(3334)).toBe("$33.34");
    expect(formatMoney(5)).toBe("$0.05");
  });
});

describe("cart validation", () => {
  const menu = buildMenu(canteenCatalog(), LOC);
  const stock = new Map([["V_MOZZA", 0]]);
  const msgs = (cart: Parameters<typeof validateCart>[2]) => validateCart(menu, stock, cart).map((p) => p.message);

  it("accepts a good cart", () => {
    expect(
      msgs([
        { variationId: "V_POUTINE", quantity: 2, modifierIds: ["MOD_CURDS"] },
        { variationId: "V_SODA", quantity: 1, modifierIds: ["MOD_DRP", "MOD_COCO"] },
      ]),
    ).toEqual([]);
  });
  it("catches made-up ids, sold-out items, missing and too many options", () => {
    expect(msgs([{ variationId: "V_NACHOS", quantity: 1, modifierIds: [] }])[0]).toMatch(/unknown item/);
    expect(msgs([{ variationId: "V_MOZZA", quantity: 1, modifierIds: [] }])[0]).toMatch(/sold out/);
    expect(msgs([{ variationId: "V_SODA", quantity: 1, modifierIds: [] }])[0]).toMatch(/needs a choice for "Soda base"/);
    expect(msgs([{ variationId: "V_SODA", quantity: 1, modifierIds: ["MOD_DRP", "MOD_COKE"] }])[0]).toMatch(/at most 1/);
    expect(msgs([{ variationId: "V_SODA", quantity: 1, modifierIds: ["MOD_DRP", "MOD_VAN"] }])[0]).toMatch(/"Vanilla" is sold out/);
    expect(msgs([{ variationId: "V_FRIES_L", quantity: 1, modifierIds: ["MOD_CURDS"] }])[0]).toMatch(/isn't available on Fries/);
    expect(msgs([{ variationId: "V_FRIES_L", quantity: 0, modifierIds: [] }])[0]).toMatch(/quantity/);
    expect(msgs([])[0]).toMatch(/empty/);
  });
  it("won't sell more than what's in stock", () => {
    const m = validateCart(menu, new Map([["V_MOZZA", 3]]), [
      { variationId: "V_MOZZA", quantity: 2, modifierIds: [] },
      { variationId: "V_MOZZA", quantity: 2, modifierIds: [] },
    ]);
    expect(m.map((p) => p.message)).toEqual(["Only 3 Mozza Sticks left; the cart has 4."]);
  });
});

describe("Square order + summary", () => {
  it("builds a pickup order and a summary from Square's numbers", async () => {
    const conv = { ...newConversation("+18075551234"), customerName: "Jordan", pickupNote: "after 2nd period" };
    const input = buildSquareOrder({
      locationId: LOC,
      conv,
      orderNumber: 47,
      cart: [
        { variationId: "V_POUTINE", quantity: 2, modifierIds: [] },
        { variationId: "V_FRIES_L", quantity: 1, modifierIds: [] },
        { variationId: "V_SODA", quantity: 1, modifierIds: ["MOD_DRP"] },
      ],
    });
    expect(input.reference_id).toBe("TEXT-47");
    expect(input.fulfillments?.[0]).toMatchObject({
      type: "PICKUP",
      pickup_details: { recipient: { display_name: "Jordan", phone_number: "+18075551234" }, note: "Text order #47 · after 2nd period" },
    });
    const quote = quoteFromOrder(await new FakeSquare().calculateOrder(input));
    expect(quote.text).toBe(
      ["2 × Poutine · $18.00", "1 × Fries (Large) · $6.00", "1 × Dirty Soda · $5.00", "   + Dr Pepper", "Tax · $3.77", "Total $32.77"].join("\n"),
    );
  });
});

describe("Square webhook signature", () => {
  it("accepts a correct signature and rejects tampering", () => {
    const url = "https://order.example.com/webhooks/square";
    const body = '{"event_id":"e1"}';
    const sig = signSquareBody("key", url, body);
    expect(verifySquareSignature({ signatureKey: "key", notificationUrl: url, rawBody: body, signature: sig })).toBe(true);
    expect(verifySquareSignature({ signatureKey: "key", notificationUrl: url, rawBody: body + " ", signature: sig })).toBe(false);
    expect(verifySquareSignature({ signatureKey: "key", notificationUrl: url, rawBody: body, signature: undefined })).toBe(false);
  });
});
