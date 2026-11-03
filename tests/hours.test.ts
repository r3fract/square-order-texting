import { describe, expect, it } from "vitest";
import { parseHours } from "../src/config.js";
import { describeHours, isOpen } from "../src/guards.js";
import { HoursService, hoursFromBusinessHours } from "../src/hours.js";
import { TextOrderService } from "../src/service.js";
import { MemoryStore } from "../src/store/memory.js";
import { FakeSms, FakeSquare, ScriptedModel, say, testConfig, tool } from "./fakes.js";

const tz = "America/Toronto";
const MON_FRI_9_5 = ["MON", "TUE", "WED", "THU", "FRI"].map((d) => ({ day_of_week: d, start_local_time: "09:00:00", end_local_time: "17:00:00" }));

describe("hours from Square", () => {
  it("maps Square periods to ordering hours", () => {
    expect(hoursFromBusinessHours([{ day_of_week: "MON", start_local_time: "09:00:00", end_local_time: "17:00:00" }])).toEqual({
      mon: { open: 540, close: 1020 },
    });
  });

  it("two periods on one day keep the earliest open and latest close", () => {
    expect(
      hoursFromBusinessHours([
        { day_of_week: "SAT", start_local_time: "17:00:00", end_local_time: "23:00:00" },
        { day_of_week: "SAT", start_local_time: "11:00:00", end_local_time: "14:00:00" },
      ]),
    ).toEqual({ sat: { open: 660, close: 1380 } });
  });

  it("no periods means closed", () => {
    expect(hoursFromBusinessHours([])).toBeNull();
    expect(hoursFromBusinessHours(undefined)).toBeNull();
    expect(isOpen(hoursFromBusinessHours([]), new Date("2026-11-03T23:00:00Z"), tz)).toBe(false);
    expect(describeHours(null)).toBe("not set");
  });

  it("override beats Square", async () => {
    const sq = new FakeSquare();
    sq.businessHours = MON_FRI_9_5;
    const svc = new HoursService(sq, parseHours("sun=10:00-11:00"));
    expect(await svc.current()).toEqual({ sun: { open: 600, close: 660 } });
    expect(sq.calls).not.toContain("retrieveLocation");
  });

  it("keeps last good hours when Square fails", async () => {
    const sq = new FakeSquare();
    sq.businessHours = MON_FRI_9_5;
    const svc = new HoursService(sq, null, 0); // ttl 0: always re-fetch
    const first = await svc.current();
    expect(first?.mon).toEqual({ open: 540, close: 1020 });
    sq.failNext.retrieveLocation = new Error("Square down");
    expect(await svc.current()).toEqual(first);
  });

  it("Square failing with no hours ever loaded means closed", async () => {
    const sq = new FakeSquare();
    sq.failNext.retrieveLocation = new Error("Square down");
    expect(await new HoursService(sq, null).current()).toBeNull();
  });

  it("caches Square hours between calls", async () => {
    const sq = new FakeSquare();
    sq.businessHours = MON_FRI_9_5;
    const svc = new HoursService(sq, null);
    await svc.current();
    await svc.current();
    expect(sq.calls.filter((c) => c === "retrieveLocation")).toHaveLength(1);
  });

  it("outside Square's hours the AI is told it's closed and no link can be made", async () => {
    const square = new FakeSquare();
    square.businessHours = MON_FRI_9_5;
    const sms = new FakeSms();
    const model = new ScriptedModel([tool("set_cart", { lines: [{ variation_id: "V_POUTINE", quantity: 2 }] }), tool("send_checkout_link"), say("Sorry, we're closed.")]);
    const service = new TextOrderService({
      config: testConfig({ ORDERING_HOURS: "" }),
      store: new MemoryStore(),
      square,
      sms,
      model,
      now: () => new Date("2026-11-03T23:42:00Z"), // Tue 6:42pm Toronto
      log: () => {},
    });
    await service.handleInboundSms({ from: "+18075551234", body: "2 poutines please", messageSid: "SMh1" });
    expect(model.requests[0]!.system).toContain("Text ordering is closed right now. Text ordering opens tomorrow at 9am.");
    expect(model.requests[0]!.system).toContain("Text ordering hours: Monday 9am-5pm");
    expect(square.calls).not.toContain("createPaymentLink");
    expect(sms.last("+18075551234")).toBe("Sorry, we're closed.");
  });

  it("a Square outage right after startup doesn't cancel everyone's links", async () => {
    const square = new FakeSquare();
    square.businessHours = MON_FRI_9_5;
    const store = new MemoryStore();
    const sms = new FakeSms();
    let clock = new Date("2026-11-03T16:00:00Z"); // Tue 11am Toronto: open
    const model = new ScriptedModel([tool("set_cart", { lines: [{ variation_id: "V_POUTINE", quantity: 1 }] }), tool("send_checkout_link"), say("link")]);
    const make = () =>
      new TextOrderService({ config: testConfig({ ORDERING_HOURS: "" }), store, square, sms, model, now: () => clock, log: () => {} });
    await make().handleInboundSms({ from: "+18075551234", body: "poutine", messageSid: "SMh9" });
    expect(square.links.size).toBe(1);
    // restart; Square's location API is down for a moment
    const restarted = make();
    square.failNext.retrieveLocation = new Error("Square down");
    clock = new Date("2026-11-03T16:01:00Z");
    await restarted.expireStaleLinks();
    expect([...square.links.values()][0]!.deleted).toBe(false);
  });

  it("with no hours anywhere, ordering is closed", async () => {
    const square = new FakeSquare(); // no business hours
    const model = new ScriptedModel([say("Sorry.")]);
    const service = new TextOrderService({
      config: testConfig({ ORDERING_HOURS: "" }), store: new MemoryStore(), square, sms: new FakeSms(), model,
      now: () => new Date("2026-11-03T23:42:00Z"), log: () => {},
    });
    expect(await service.orderingStatus()).toEqual({ open: false, message: "Text ordering isn't open right now. Please order at the window." });
  });
});
