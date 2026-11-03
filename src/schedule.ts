import { ordinal } from "./game/service.js";
import type { Timeline } from "./game/timeline.js";
import { shortTime } from "./pickup.js";
import type { SquareApi } from "./square/client.js";
import type { Store } from "./store/types.js";

const MOVE_SQUARE_MS = 3 * 60_000; // update the kitchen's pickup time when the intermission moves this much
const TEXT_CUSTOMER_MS = 5 * 60_000; // tell the customer when their quoted time moves this much (once per order)

export interface ScheduleDeps {
  square: SquareApi;
  store: Store;
  now: () => Date;
  tz: string;
  sendCustomer: (phone: string, text: string) => Promise<boolean>;
  notifyOwner: (text: string) => Promise<void>;
  /** Order ids the owner was already alerted about, so a stuck order doesn't alert on every poll. */
  alerted?: Set<string>;
}

/** Moves paid, not-yet-ready game-slot orders to follow a new intermission estimate. */
export async function reconcileSchedule(d: ScheduleDeps, _prev: Timeline | null, next: Timeline): Promise<void> {
  if (!next.trustworthy) return; // feed unsure: keep the last pickup times
  const orders = await d.store.listOrdersInSlotPrefix(`game:${next.gameId}:`);
  for (const order of orders) {
    if (order.status !== "paid" || !order.pickupAt) continue;
    const slot = order.pickupSlot!.split(":").at(-1)!; // int1 | int2 | end
    const periodNo = slot === "end" ? 3 : Number(slot.slice(-1));
    const newStart = slot === "end" ? next.gameEnd : next.intermissionStarts[periodNo as 1 | 2];
    if (!newStart) continue; // that break has started: nothing more to move

    if (Math.abs(newStart.getTime() - order.pickupAt.getTime()) >= MOVE_SQUARE_MS) {
      try {
        const sq = await d.square.retrieveOrder(order.squareOrderId);
        const uid = sq.fulfillments?.[0]?.uid;
        if (sq.version == null || !uid) throw new Error("order has no version or fulfillment");
        await d.square.updatePickupAt({ orderId: order.squareOrderId, version: sq.version, fulfillmentUid: uid, pickupAt: newStart });
        order.pickupAt = newStart;
        await d.store.updateOrder(order.id, { pickupAt: newStart });
      } catch {
        if (d.alerted?.has(order.id)) continue;
        d.alerted?.add(order.id);
        await d.notifyOwner(`⚠️ Couldn't move order #${order.orderNumber} to ${shortTime(newStart, d.tz)} in Square. It may be ready early.`);
        if (!order.etaNotifiedAt && order.quotedReadyAt) {
          await d.sendCustomer(order.phone, `Heads up: order #${order.orderNumber} may be ready a little before ${shortTime(order.quotedReadyAt, d.tz)}.`);
          await d.store.updateOrder(order.id, { etaNotifiedAt: d.now() });
        }
        continue;
      }
    }

    const quoted = order.quotedReadyAt;
    if (quoted && !order.etaNotifiedAt && Math.abs(newStart.getTime() - quoted.getTime()) >= TEXT_CUSTOMER_MS) {
      const way = newStart > quoted ? "long" : "short";
      await d.sendCustomer(
        order.phone,
        `Heads up: the ${ordinal(periodNo)} period is running ${way}. Order #${order.orderNumber} will be ready about ${shortTime(newStart, d.tz)}.`,
      );
      await d.store.updateOrder(order.id, { etaNotifiedAt: d.now(), quotedReadyAt: newStart });
    }
  }
}
